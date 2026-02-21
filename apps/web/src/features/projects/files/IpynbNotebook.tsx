/**
 * Editable Jupyter Notebook (.ipynb) wrapper.
 *
 * Provides custom parse/serialize functions to the RmdNotebook so that
 * ipynb JSON is converted to/from RmdCell[] directly, without going
 * through the Rmd text format.
 */

import { useCallback, useRef, forwardRef, useImperativeHandle } from 'react'
import { RmdNotebook, type RmdNotebookHandle } from './RmdNotebook'
import {
  parseIpynbFile,
  ipynbToRmdCells,
  rmdCellsToIpynb,
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
}

export const IpynbNotebook = forwardRef<RmdNotebookHandle, IpynbNotebookProps>(
  function IpynbNotebook({ content, onChange, readOnly, onSave, onRenderOutput, activeConnectionId }, ref) {
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

    // Forward imperative handle
    useImperativeHandle(ref, () => rmdRef.current!, [])

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
      />
    )
  },
)
