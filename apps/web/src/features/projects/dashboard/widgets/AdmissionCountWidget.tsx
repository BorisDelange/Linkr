import { Activity, TrendingUp } from 'lucide-react'

export function AdmissionCountWidget() {
  return (
    <div className="flex h-full flex-col justify-center">
      <div className="flex items-center gap-2">
        <div className="rounded-md bg-blue-500/10 p-2">
          <Activity size={16} className="text-blue-500" />
        </div>
        <div>
          <p className="text-2xl font-bold text-foreground">12,847</p>
          <p className="text-xs text-muted-foreground">Admissions</p>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1 text-xs text-emerald-600">
        <TrendingUp size={12} />
        <span>+5.2% vs previous month</span>
      </div>
    </div>
  )
}
