import { PageHeader } from '../components/ui'
import { MyPasswordSection } from './Settings'

/** Your own sign-in. Open to everyone, whatever their security group. */
export default function Account({ email }: { email?: string }) {
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Your account" subtitle={email} />
      <MyPasswordSection />
    </div>
  )
}
