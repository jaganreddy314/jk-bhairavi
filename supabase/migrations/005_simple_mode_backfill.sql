-- Days entered before a business switched to 'simple' hold the figure in the channel
-- columns. Move it to total_recorded, which is what the simple form reads and writes.
-- The day's takings are unchanged: total_recorded is set to the very sum it replaces.
-- cash_collected stays null - it was never recorded and isn't invented here.
begin;

update sales_days s
set total_recorded = s.eftpos + s.cash + s.uber + s.online,
    eftpos = 0, cash = 0, uber = 0, online = 0
from businesses b
where b.id = s.business_id
  and b.sales_mode = 'simple'
  and s.total_recorded is null
  and s.eftpos + s.cash + s.uber + s.online > 0;

commit;
