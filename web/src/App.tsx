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

// Charts are the heaviest code; load them only when a page that draws them opens.
const Dashboard = lazy(() => import('./pages/Dashboard'))
const FoodCost = lazy(() => import('./pages/FoodCost'))

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
                  <Route index element={<Suspense fallback={<Loading />}><Dashboard /></Suspense>} />
                  <Route path="sales" element={<SalesEntry />} />
                  <Route path="expenses" element={<ExpensesList />} />
                  <Route path="expenses/new" element={<ExpenseForm />} />
                  <Route path="expenses/:id" element={<ExpenseForm />} />
                  <Route path="recurring" element={<Recurring />} />
                  <Route path="orders" element={<Orders />} />
                  <Route path="orders/new" element={<OrderForm />} />
                  <Route path="orders/:id" element={<OrderForm />} />
                  <Route path="stock" element={<StockCounts />} />
                  <Route path="stock/:id" element={<StockCountSheet />} />
                  <Route path="food-cost" element={<Suspense fallback={<Loading />}><FoodCost /></Suspense>} />
                  <Route path="settings" element={<Settings />} />
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
