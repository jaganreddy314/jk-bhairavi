-- Where each item sits in its supplier's list: the order you go through it when
-- ordering (often the order of the supplier's own price list or the shelves).
-- An item has one usual supplier, so one position is enough. Ties fall back to name,
-- so items nobody has arranged yet stay alphabetical.
begin;

alter table stock_items add column supplier_sort int not null default 0;

commit;
