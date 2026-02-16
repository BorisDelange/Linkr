import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceArea,
  ResponsiveContainer,
} from 'recharts'

// Generate 24h of heart rate data
const data = Array.from({ length: 24 }, (_, i) => ({
  hour: `${String(i).padStart(2, '0')}:00`,
  hr: Math.round(65 + Math.random() * 30 + (i > 6 && i < 22 ? 5 : -5)),
}))

export function HeartRateWidget() {
  return (
    <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
      <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
        <ReferenceArea
          y1={60}
          y2={100}
          fill="var(--color-chart-2)"
          fillOpacity={0.08}
        />
        <XAxis
          dataKey="hour"
          tick={{ fontSize: 10 }}
          interval={3}
          className="text-muted-foreground"
        />
        <YAxis
          domain={[40, 120]}
          tick={{ fontSize: 10 }}
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
          formatter={(value) => [`${value} bpm`, 'Heart rate']}
        />
        <Line
          type="monotone"
          dataKey="hr"
          stroke="var(--color-chart-4)"
          strokeWidth={2}
          dot={{ r: 2 }}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
