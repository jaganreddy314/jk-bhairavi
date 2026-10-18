-- Refunds. A till report can show a product's week as negative (a refund larger than its
-- sales, e.g. -$0.01), and it has to be stored as it is or the week won't add up to the report.
-- Lines that come to exactly nothing are still left out.
begin;

alter table item_sales drop constraint item_sales_qty_check;
alter table item_sales drop constraint item_sales_amount_check;

create or replace function replace_item_sales(p_business uuid, p_start date, p_end date, p_rows jsonb)
returns int language plpgsql set search_path = public as $$
declare n int;
begin
  if not is_member(p_business) then
    raise exception 'Not a member of this business';
  end if;
  delete from item_sales where business_id = p_business and period_start = p_start and period_end = p_end;
  insert into item_sales (business_id, item_id, period_start, period_end, qty, amount)
  select p_business, (r->>'item_id')::uuid, p_start, p_end,
         coalesce((r->>'qty')::numeric, 0), coalesce((r->>'amount')::numeric, 0)
  from jsonb_array_elements(p_rows) r
  where coalesce((r->>'qty')::numeric, 0) <> 0 or coalesce((r->>'amount')::numeric, 0) <> 0;
  get diagnostics n = row_count;
  return n;
end $$;

commit;
