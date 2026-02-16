import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  restrictToVerticalAxis,
  restrictToParentElement,
} from '@dnd-kit/modifiers'
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Plus,
  X,
  CheckCircle2,
  Circle,
  GripVertical,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useAppStore } from '@/stores/app-store'
import type { TodoItem } from '@/types'

interface SummaryTasksTabProps {
  uid: string
}

export function SummaryTasksTab({ uid }: SummaryTasksTabProps) {
  const { t } = useTranslation()
  const {
    _projectsRaw,
    updateProjectTodos,
    updateProjectNotes,
  } = useAppStore()

  const project = _projectsRaw.find((p) => p.uid === uid)
  const todos = project?.todos ?? []
  const notes = project?.notes ?? ''

  // Todo
  const [newTask, setNewTask] = useState('')

  const handleToggleTodo = (id: string) => {
    const updated = todos.map((t) =>
      t.id === id ? { ...t, done: !t.done } : t,
    )
    updateProjectTodos(uid, updated)
  }

  const handleAddTodo = () => {
    if (!newTask.trim()) return
    const item: TodoItem = {
      id: `t-${Date.now()}`,
      text: newTask.trim(),
      done: false,
    }
    updateProjectTodos(uid, [...todos, item])
    setNewTask('')
  }

  const handleRemoveTodo = (id: string) => {
    updateProjectTodos(
      uid,
      todos.filter((t) => t.id !== id),
    )
  }

  const todoSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  const handleTodoDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = todos.findIndex((t) => t.id === active.id)
    const newIndex = todos.findIndex((t) => t.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    updateProjectTodos(uid, arrayMove(todos, oldIndex, newIndex))
  }

  // Notes with debounce
  const [localNotes, setLocalNotes] = useState(notes)
  const notesDebounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    setLocalNotes(notes)
  }, [notes])

  const handleNotesChange = useCallback(
    (value: string) => {
      setLocalNotes(value)
      if (notesDebounceRef.current) clearTimeout(notesDebounceRef.current)
      notesDebounceRef.current = setTimeout(() => {
        updateProjectNotes(uid, value)
      }, 500)
    },
    [uid, updateProjectNotes],
  )

  return (
    <div className="flex h-full min-h-0 gap-6 pt-2">
      {/* Todo — left half */}
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <h2 className="shrink-0 text-xs font-semibold uppercase text-muted-foreground">
          {t('summary.todo')}
        </h2>
        <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="flex min-h-0 flex-1 flex-col p-4">
            <div className="min-h-0 flex-1 overflow-auto">
              {todos.length > 0 && (
                <DndContext
                  sensors={todoSensors}
                  collisionDetection={closestCenter}
                  modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                  onDragEnd={handleTodoDragEnd}
                >
                  <SortableContext
                    items={todos.map((t) => t.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-1">
                      {todos.map((todo) => (
                        <SortableTodoItem
                          key={todo.id}
                          todo={todo}
                          onToggle={handleToggleTodo}
                          onRemove={handleRemoveTodo}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </div>
            <div className="mt-2 flex shrink-0 items-center gap-2">
              <Input
                value={newTask}
                onChange={(e) => setNewTask(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddTodo()}
                placeholder={t('summary.add_task_placeholder')}
                className="h-8 text-sm"
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={handleAddTodo}
                disabled={!newTask.trim()}
              >
                <Plus size={14} />
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Notes — right half */}
      <div className="flex h-full min-h-0 flex-1 flex-col">
        <h2 className="shrink-0 text-xs font-semibold uppercase text-muted-foreground">
          {t('summary.notes')}
        </h2>
        <div className="mt-3 min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="h-full p-4">
            <Textarea
              value={localNotes}
              onChange={(e) => handleNotesChange(e.target.value)}
              placeholder={t('summary.notes_placeholder')}
              className="h-full resize-none border-0 p-0 shadow-none focus-visible:ring-0"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function SortableTodoItem({
  todo,
  onToggle,
  onRemove,
}: {
  todo: TodoItem
  onToggle: (id: string) => void
  onRemove: (id: string) => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: todo.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group flex items-center gap-1 rounded-md px-1 py-1 hover:bg-accent"
    >
      <button
        {...attributes}
        {...listeners}
        className="shrink-0 cursor-grab text-muted-foreground/40 opacity-0 group-hover:opacity-100 active:cursor-grabbing"
      >
        <GripVertical size={14} />
      </button>
      <button
        onClick={() => onToggle(todo.id)}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        {todo.done ? (
          <CheckCircle2 size={16} className="text-primary" />
        ) : (
          <Circle size={16} />
        )}
      </button>
      <span
        className={`flex-1 text-sm ${todo.done ? 'text-muted-foreground line-through' : 'text-foreground'}`}
      >
        {todo.text}
      </span>
      <button
        onClick={() => onRemove(todo.id)}
        className="shrink-0 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100"
      >
        <X size={14} />
      </button>
    </div>
  )
}
