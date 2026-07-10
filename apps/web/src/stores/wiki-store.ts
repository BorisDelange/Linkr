import { create } from 'zustand'
import { getStorage } from '@/lib/storage'
import { migrateEntityIds } from '@/lib/slugify-id'
import { localized, toLocalized } from '@/lib/localized'
import { stampAuthored } from '@/stores/app-store'
import type { WikiPage, LocalizedString } from '@/types'

export type WikiViewMode = 'view' | 'edit'

interface WikiTreeNode {
  page: WikiPage
  children: WikiTreeNode[]
}

interface WikiState {
  // Data
  pages: WikiPage[]
  pagesLoaded: boolean
  currentWorkspaceId: string | null

  // Active page
  activePageId: string | null
  viewMode: WikiViewMode

  // CRUD
  loadPages: (workspaceId: string) => Promise<void>
  addPage: (params: {
    workspaceId: string
    parentId: string | null
    title: LocalizedString
    entityId?: string
    content?: LocalizedString
    icon?: string
    template?: string
  }) => Promise<string>
  updatePage: (id: string, changes: Partial<WikiPage>) => Promise<void>
  savePage: (id: string, content: LocalizedString) => Promise<void>
  deletePage: (id: string) => Promise<void>
  movePage: (id: string, newParentId: string | null, newSortOrder: number) => Promise<void>
  reorderPages: (parentId: string | null, orderedIds: string[]) => Promise<void>

  // Navigation
  setActivePage: (id: string | null) => void
  setViewMode: (mode: WikiViewMode) => void

  // Computed
  getTree: () => WikiTreeNode[]
  getChildren: (parentId: string | null) => WikiPage[]
  getPage: (id: string) => WikiPage | undefined
  getBreadcrumbs: (pageId: string) => WikiPage[]
  searchPages: (query: string) => WikiPage[]
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    || 'page'
}

function buildTree(pages: WikiPage[], parentId: string | null): WikiTreeNode[] {
  return pages
    .filter((p) => p.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((page) => ({
      page,
      children: buildTree(pages, page.id),
    }))
}

export const useWikiStore = create<WikiState>((set, get) => ({
  pages: [],
  pagesLoaded: false,
  currentWorkspaceId: null,
  activePageId: null,
  viewMode: 'view',

  loadPages: async (workspaceId) => {
    const storage = getStorage()
    const pages = await storage.wikiPages.getByWorkspace(workspaceId)
    // Migration: assign entityId to pages that don't have one
    for (const p of migrateEntityIds(pages, e => localized(e.title, 'en'))) {
      storage.wikiPages.update(p.id, { entityId: p.entityId }).catch(() => {})
    }
    // Backfill: coerce legacy plain-string title/content into LocalizedString
    for (const p of pages) {
      const needsTitle = typeof p.title === 'string'
      const needsContent = typeof p.content === 'string'
      if (!needsTitle && !needsContent) continue
      if (needsTitle) p.title = toLocalized(p.title)
      if (needsContent) p.content = toLocalized(p.content)
      storage.wikiPages
        .update(p.id, { title: p.title, content: p.content })
        .catch(() => {})
    }
    set({ pages, pagesLoaded: true, currentWorkspaceId: workspaceId })
  },

  addPage: async ({ workspaceId, parentId, title, entityId, content, icon, template }) => {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const siblings = get().pages.filter((p) => p.parentId === parentId)
    const maxOrder = siblings.reduce((max, p) => Math.max(max, p.sortOrder), -1)

    const page: WikiPage = {
      id,
      entityId: entityId || undefined,
      workspaceId,
      parentId,
      title,
      slug: slugify(localized(title, 'en')),
      icon,
      content: content ?? {},
      template,
      sortOrder: maxOrder + 1,
      ...stampAuthored(),
      createdAt: now,
      updatedAt: now,
    }
    await getStorage().wikiPages.create(page)
    set((s) => ({ pages: [...s.pages, page] }))

    return id
  },

  updatePage: async (id, changes) => {
    const now = new Date().toISOString()
    const updates = { ...changes, updatedAt: now }
    if (changes.title) {
      updates.slug = slugify(localized(changes.title, 'en'))
    }
    await getStorage().wikiPages.update(id, updates)
    set((s) => ({
      pages: s.pages.map((p) => (p.id === id ? { ...p, ...updates } : p)),
    }))
  },

  savePage: async (id, content) => {
    const page = get().pages.find((p) => p.id === id)
    if (!page) return

    const now = new Date().toISOString()

    const updates = { content, updatedAt: now }
    await getStorage().wikiPages.update(id, updates)
    const updatedPage = { ...page, ...updates }
    set((s) => ({
      pages: s.pages.map((p) => (p.id === id ? updatedPage : p)),
    }))

  },

  deletePage: async (id) => {
    // Delete page and all descendants
    const allPages = get().pages
    const toDelete = new Set<string>()

    function collectDescendants(parentId: string) {
      toDelete.add(parentId)
      for (const p of allPages) {
        if (p.parentId === parentId) collectDescendants(p.id)
      }
    }
    collectDescendants(id)

    const storage = getStorage()
    for (const pageId of toDelete) {
      await storage.wikiAttachments.deleteByPage(pageId)
      await storage.wikiPages.delete(pageId)
    }

    set((s) => ({
      pages: s.pages.filter((p) => !toDelete.has(p.id)),
      activePageId: toDelete.has(s.activePageId ?? '') ? null : s.activePageId,
    }))

  },

  movePage: async (id, newParentId, newSortOrder) => {
    const now = new Date().toISOString()
    await getStorage().wikiPages.update(id, {
      parentId: newParentId,
      sortOrder: newSortOrder,
      updatedAt: now,
    })
    set((s) => ({
      pages: s.pages.map((p) =>
        p.id === id ? { ...p, parentId: newParentId, sortOrder: newSortOrder, updatedAt: now } : p,
      ),
    }))
  },

  reorderPages: async (_parentId, orderedIds) => {
    const now = new Date().toISOString()
    const storage = getStorage()
    const updates: { id: string; sortOrder: number }[] = orderedIds.map((id, i) => ({ id, sortOrder: i }))
    for (const { id, sortOrder } of updates) {
      await storage.wikiPages.update(id, { sortOrder, updatedAt: now })
    }
    set((s) => ({
      pages: s.pages.map((p) => {
        const update = updates.find((u) => u.id === p.id)
        return update ? { ...p, sortOrder: update.sortOrder, updatedAt: now } : p
      }),
    }))
  },

  setActivePage: (id) => set({ activePageId: id, viewMode: 'view' }),
  setViewMode: (mode) => set({ viewMode: mode }),

  getTree: () => buildTree(get().pages, null),

  getChildren: (parentId) =>
    get()
      .pages.filter((p) => p.parentId === parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder),

  getPage: (id) => get().pages.find((p) => p.id === id),

  getBreadcrumbs: (pageId) => {
    const pages = get().pages
    const crumbs: WikiPage[] = []
    let current = pages.find((p) => p.id === pageId)
    while (current) {
      crumbs.unshift(current)
      current = current.parentId ? pages.find((p) => p.id === current!.parentId) : undefined
    }
    return crumbs
  },

  searchPages: (query) => {
    const q = query.toLowerCase()
    const values = (v: WikiPage['title'] | WikiPage['content']) =>
      Object.values(toLocalized(v)).join(' ').toLowerCase()
    return get().pages.filter(
      (p) => values(p.title).includes(q) || values(p.content).includes(q),
    )
  },
}))
