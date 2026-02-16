import { Users, TrendingUp } from 'lucide-react'

export function PatientCountWidget() {
  return (
    <div className="flex h-full flex-col justify-center">
      <div className="flex items-center gap-2">
        <div className="rounded-md bg-violet-500/10 p-2">
          <Users size={16} className="text-violet-500" />
        </div>
        <div>
          <p className="text-2xl font-bold text-foreground">3,421</p>
          <p className="text-xs text-muted-foreground">Patients</p>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1 text-xs text-emerald-600">
        <TrendingUp size={12} />
        <span>+2.1% vs previous month</span>
      </div>
    </div>
  )
}
