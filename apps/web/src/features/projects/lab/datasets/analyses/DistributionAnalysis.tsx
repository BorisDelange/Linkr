import { useTranslation } from 'react-i18next'
import type { DatasetAnalysis } from '@/types'

interface DistributionAnalysisProps {
  analysis: DatasetAnalysis
}

export function DistributionAnalysis({ analysis }: DistributionAnalysisProps) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center justify-center p-8 text-center">
      <p className="text-sm font-medium text-foreground">{analysis.name}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        {t('datasets.analysis_stub_description')}
      </p>
    </div>
  )
}
