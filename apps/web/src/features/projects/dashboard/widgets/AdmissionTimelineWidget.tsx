import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

const data = [
  { month: 'Mar', admissions: 980 },
  { month: 'Apr', admissions: 1050 },
  { month: 'May', admissions: 1120 },
  { month: 'Jun', admissions: 1080 },
  { month: 'Jul', admissions: 1150 },
  { month: 'Aug', admissions: 1020 },
  { month: 'Sep', admissions: 1180 },
  { month: 'Oct', admissions: 1250 },
  { month: 'Nov', admissions: 1100 },
  { month: 'Dec', admissions: 1050 },
  { month: 'Jan', admissions: 1220 },
  { month: 'Feb', admissions: 1340 },
]

export function AdmissionTimelineWidget() {
  return (
    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
      <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <XAxis
          dataKey="month"
          tick={{ fontSize: 11 }}
          className="text-muted-foreground"
        />
        <YAxis
          tick={{ fontSize: 11 }}
          className="text-muted-foreground"
        />
        <Tooltip
          contentStyle={{
            fontSize: 12,
            borderRadius: 8,
            border: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-popover)',
            color: 'var(--color-popover-foreground)',
          }}
        />
        <Line
          type="monotone"
          dataKey="admissions"
          stroke="var(--color-chart-1)"
          strokeWidth={2}
          dot={{ r: 3 }}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
