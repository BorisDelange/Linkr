/**
 * Editable Jupyter Notebook (.ipynb) wrapper.
 *
 * Provides custom parse/serialize functions to the RmdNotebook so that
 * ipynb JSON is converted to/from RmdCell[] directly, without going
 * through the Rmd text format.
 */

import { useCallback, useRef, forwardRef, useImperativeHandle } from 'react'
import { RmdNotebook, type RmdNotebookHandle, type CellState } from './RmdNotebook'
import {
  parseIpynbFile,
  ipynbToRmdCells,
  rmdCellsToIpynb,
  rmdCellsToIpynbWithOutputs,
  type IpynbNotebook as IpynbNotebookType,
} from '@/lib/ipynb-parser'
import type { RmdCell } from '@/lib/rmd-parser'

interface IpynbNotebookProps {
  content: string
  onChange?: (newContent: string) => void
  readOnly?: boolean
  onSave?: () => void
  onRenderOutput?: (html: string, title: string) => void
  activeConnectionId?: string | null
  fileName?: string
  initialCellStates?: CellState[]
  onCellStatesChange?: (states: CellState[]) => void
}

export interface IpynbNotebookHandle extends RmdNotebookHandle {
  downloadNotebook: (withOutputs: boolean) => void
}

export const IpynbNotebook = forwardRef<IpynbNotebookHandle, IpynbNotebookProps>(
  function IpynbNotebook({ content, onChange, readOnly, onSave, onRenderOutput, activeConnectionId, fileName, initialCellStates, onCellStatesChange }, ref) {
    const rmdRef = useRef<RmdNotebookHandle>(null)
    const metadataRef = useRef<IpynbNotebookType['metadata']>({})

    // Custom parse: ipynb JSON → RmdCell[]
    const parseFn = useCallback((ipynbContent: string): RmdCell[] => {
      try {
        const notebook = parseIpynbFile(ipynbContent)
        metadataRef.current = notebook.metadata
        return ipynbToRmdCells(notebook)
      } catch {
        return []
      }
    }, [])

    // Custom serialize: RmdCell[] → ipynb JSON
    const serializeFn = useCallback((cells: RmdCell[]): string => {
      return rmdCellsToIpynb(cells, metadataRef.current)
    }, [])

    // Download as .ipynb file
    const downloadNotebook = useCallback((withOutputs: boolean) => {
      if (!rmdRef.current) return
      const cells = rmdRef.current.getCells()
      const cellStates = rmdRef.current.getCellStates()

      let json: string
      if (withOutputs) {
        const outputMap = new Map<string, import('@/lib/runtimes/types').RuntimeOutput>()
        for (const [id, state] of cellStates) {
          if (state.output) outputMap.set(id, state.output)
        }
        json = rmdCellsToIpynbWithOutputs(cells, metadataRef.current, outputMap)
      } else {
        json = rmdCellsToIpynb(cells, metadataRef.current)
      }

      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName ?? 'notebook.ipynb'
      a.click()
      URL.revokeObjectURL(url)
    }, [fileName])

    // Forward imperative handle — delegate to rmdRef at call time (not capture time)
    // so that methods like runCell/runAll always use the latest RmdNotebook handle.
    useImperativeHandle(ref, () => ({
      runCell: () => rmdRef.current?.runCell(),
      runAll: () => rmdRef.current?.runAll(),
      runAbove: () => rmdRef.current?.runAbove(),
      renderPreview: () => rmdRef.current?.renderPreview(),
      renderHtml: () => rmdRef.current?.renderHtml(),
      renderPdf: () => rmdRef.current?.renderPdf(),
      addCell: (type: 'markdown' | 'code' | 'yaml', language?: string) => rmdRef.current?.addCell(type, language),
      get hasYamlCell() { return rmdRef.current?.hasYamlCell ?? false },
      get isRendering() { return rmdRef.current?.isRendering ?? false },
      getCells: () => rmdRef.current?.getCells() ?? [],
      getCellStates: () => rmdRef.current?.getCellStates() ?? new Map(),
      get sourceView() { return rmdRef.current?.sourceView ?? false },
      toggleSourceView: () => rmdRef.current?.toggleSourceView(),
      scrollToCell: (cellId: string) => rmdRef.current?.scrollToCell(cellId),
      downloadNotebook,
    }), [downloadNotebook])

    return (
      <RmdNotebook
        ref={rmdRef}
        content={content}
        onChange={onChange}
        readOnly={readOnly}
        onSave={onSave}
        onRenderOutput={onRenderOutput}
        activeConnectionId={activeConnectionId}
        parseFn={parseFn}
        serializeFn={serializeFn}
        shortcutPrefix="ipynb"
        notebookFormat="ipynb"
        initialCellStates={initialCellStates}
        onCellStatesChange={onCellStatesChange}
      />
    )
  },
)
