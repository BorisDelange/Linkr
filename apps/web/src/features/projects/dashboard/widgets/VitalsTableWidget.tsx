import { cn } from '@/lib/utils'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

interface VitalSign {
  parameter: string
  value: number
  unit: string
  time: string
  isAbnormal: boolean
}

const vitals: VitalSign[] = [
  { parameter: 'Heart rate', value: 92, unit: 'bpm', time: '14:30', isAbnormal: false },
  { parameter: 'BP Systolic', value: 145, unit: 'mmHg', time: '14:30', isAbnormal: true },
  { parameter: 'BP Diastolic', value: 88, unit: 'mmHg', time: '14:30', isAbnormal: false },
  { parameter: 'SpO2', value: 96, unit: '%', time: '14:30', isAbnormal: false },
  { parameter: 'Temperature', value: 38.2, unit: '°C', time: '14:25', isAbnormal: true },
  { parameter: 'Resp. rate', value: 18, unit: '/min', time: '14:30', isAbnormal: false },
]

export function VitalsTableWidget() {
  return (
    <div className="h-full overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">Parameter</TableHead>
            <TableHead className="text-xs text-right">Value</TableHead>
            <TableHead className="text-xs">Unit</TableHead>
            <TableHead className="text-xs">Time</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {vitals.map((v) => (
            <TableRow key={v.parameter}>
              <TableCell className="text-xs font-medium">
                {v.parameter}
              </TableCell>
              <TableCell
                className={cn(
                  'text-xs text-right font-mono',
                  v.isAbnormal && 'text-destructive font-semibold'
                )}
              >
                {v.value}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {v.unit}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {v.time}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
