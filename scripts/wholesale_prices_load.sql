-- Second half of the SQL scripts/wholesale_prices.py prints: takes the rows it put in _import
-- and files them under wholesale_* (migration 025). Run as a platform admin or the postgres role.

insert into wholesalers (name)
select distinct wholesaler from _import
on conflict (name) do nothing;

-- Products: an existing one with the same barcode or match_key, otherwise a new one named
-- after the first wholesaler in the file that lists it (Trax's names are the clearest).
alter table _import add column product_id uuid;

update _import i set product_id = p.id
from wholesale_products p where i.gtin is not null and i.gtin = any(p.gtins);

update _import i set product_id = p.id
from wholesale_products p where i.product_id is null and p.match_key = i.match_key;

insert into wholesale_products (name, category, size, unit, match_key)
select distinct on (match_key) name, category, size, unit, match_key
from _import where product_id is null
order by match_key, pos;

update _import i set product_id = p.id
from wholesale_products p where i.product_id is null and p.match_key = i.match_key;

-- Remember every barcode, so next month's file finds the product by it.
update wholesale_products p set gtins = array(select distinct unnest(p.gtins || g.gtins) order by 1)
from (select product_id, array_agg(distinct gtin) as gtins from _import where gtin is not null group by product_id) g
where g.product_id = p.id and not g.gtins <@ p.gtins;

-- One price list per wholesaler in this file.
create temp table _lists on commit drop as
with l as (
  insert into wholesale_price_lists (wholesaler_id, effective_from, effective_to, source)
  select w.id, i.effective_from, i.effective_to, i.source
  from (select distinct wholesaler, effective_from, effective_to, source from _import) i
  join wholesalers w on w.name = i.wholesaler
  returning id, wholesaler_id
)
select l.id, w.name from l join wholesalers w on w.id = l.wholesaler_id;

-- A wholesaler listing the same product twice in the same pack (Metcash's "Other" and
-- "Other Updated") keeps the later line.
insert into wholesale_prices (price_list_id, product_id, supplier_code, gtin, description, units, price_ex_gst, price_inc_gst)
select distinct on (l.id, i.product_id, i.units) l.id, i.product_id, i.code, i.gtin, i.description, i.units, i.price_ex, i.price_inc
from _import i join _lists l on l.name = i.wholesaler
order by l.id, i.product_id, i.units, i.pos desc;

select w.name as wholesaler, count(*) as prices
from wholesale_prices p join _lists l on l.id = p.price_list_id join wholesalers w on w.name = l.name
group by w.name order by w.name;
