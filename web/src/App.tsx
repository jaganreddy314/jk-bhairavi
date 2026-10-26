import { lazy, Suspense } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthGate, Centered } from './components/Auth'
import { BusinessGate } from './components/BusinessGate'
import { Loading } from './components/ui'
import { Layout } from './components/Layout'
import { isConfigured } from './lib/supabase'
import SalesEntry from './pages/SalesEntry'
import ExpenseForm from './pages/ExpenseForm'
import ExpensesList from './pages/ExpensesList'
import Recurring from './pages/Recurring'
import Settings from './pages/Settings'
import Orders from './pages/Orders'
import OrderForm from './pages/OrderForm'
import StockCounts from './pages/StockCounts'
import StockCountSheet from './pages/StockCountSheet'
import StockAlerts from './pages/StockAlerts'
import Catalogue from './pages/Catalogue'
import ItemSalesEntry from './pages/ItemSalesEntry'
import People from './pages/People'
import Account from './pages/Account'
import Person from './pages/Person'
import { ALERT_PERMS, Home, Need } from './lib/access'
import Schedule from './pages/Schedule'
import PayRuns, { PayRunPage, Payslips } from './pages/PayRuns'
import Businesses, { NewBusiness, PlatformOnly } from './pages/Businesses'

// Charts are the heaviest code; load them only when a page that draws them opens.
const Dashboard = lazy(() => import('./pages/Dashboard'))
const FoodCost = lazy(() => import('./pages/FoodCost'))
const ItemSales = lazy(() => import('./pages/ItemSales'))

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: true, retry: 1 } },
})

export default function App() {
  if (!isConfigured)
    return (
      <Centered>
        <h1 className="text-xl font-bold">Almost there</h1>
        <p className="mt-2 text-sm text-ink-2">
          Copy <code>.env.example</code> to <code>.env</code>, fill in <code>VITE_SUPABASE_URL</code> and{' '}
          <code>VITE_SUPABASE_ANON_KEY</code>, then restart the dev server. See the README.
        </p>
      </Centered>
    )

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <AuthGate>
          {(session) => (
            <BusinessGate email={session.user.email}>
              <Routes>
                <Route element={<Layout email={session.user.email} />}>
                  <Route index element={<Home dashboard={<Suspense fallback={<Loading />}><Dashboard /></Suspense>} />} />
                  <Route path="sales" element={<Need perms={['sales']}><SalesEntry /></Need>} />
                  <Route path="expenses" element={<Need perms={['finance']}><ExpensesList /></Need>} />
                  <Route path="expenses/new" element={<Need perms={['finance']}><ExpenseForm /></Need>} />
                  <Route path="expenses/:id" element={<Need perms={['finance']}><ExpenseForm /></Need>} />
                  <Route path="recurring" element={<Need perms={['finance']}><Recurring /></Need>} />
                  <Route path="orders" element={<Need perms={['purchasing']}><Orders /></Need>} />
                  <Route path="orders/new" element={<Need perms={['purchasing']}><OrderForm /></Need>} />
                  <Route path="orders/:id" element={<Need perms={['purchasing']}><OrderForm /></Need>} />
                  <Route path="stock" element={<Need perms={['stock']}><StockCounts /></Need>} />
                  <Route path="stock/:id" element={<Need perms={['stock']}><StockCountSheet /></Need>} />
                  <Route path="alerts" element={<Need perms={ALERT_PERMS}><StockAlerts /></Need>} />
                  <Route path="food" element={<Need perms={['finance']}><Suspense fallback={<Loading />}><FoodCost /></Suspense></Need>} />
                  <Route path="food/catalogue" element={<Need perms={['catalogue']}><Catalogue /></Need>} />
                  <Route path="food/sales" element={<Need perms={['finance']}><Suspense fallback={<Loading />}><ItemSales /></Suspense></Need>} />
                  <Route path="food/sales/add" element={<Need perms={['finance']}><ItemSalesEntry /></Need>} />
                  <Route path="food-cost" element={<Navigate to="/food" replace />} />
                  <Route path="people" element={<Need perms={['people', 'payroll', 'admin']}><People /></Need>} />
                  <Route path="people/:id" element={<Need perms={['people', 'payroll']}><Person /></Need>} />
                  <Route path="schedule" element={<Need perms={['roster']}><Schedule /></Need>} />
                  <Route path="pay-runs" element={<Need perms={['payroll']}><PayRuns /></Need>} />
                  <Route path="pay-runs/:id" element={<Need perms={['payroll']}><PayRunPage /></Need>} />
                  <Route path="pay-runs/:id/payslips" element={<Need perms={['payroll']}><Payslips /></Need>} />
                  <Route path="settings" element={<Need perms={['admin']}><Settings /></Need>} />
                  <Route path="account" element={<Account email={session.user.email} />} />
                  <Route path="admin/businesses" element={<PlatformOnly><Businesses /></PlatformOnly>} />
                  <Route path="admin/businesses/new" element={<PlatformOnly><NewBusiness /></PlatformOnly>} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </BusinessGate>
          )}
        </AuthGate>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
