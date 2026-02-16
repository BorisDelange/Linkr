/** Type declarations for the File System Access API (Chrome/Edge). */

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

interface FileSystemHandle {
  readonly kind: 'file' | 'directory'
  readonly name: string
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
}

interface FileSystemFileHandle extends FileSystemHandle {
  readonly kind: 'file'
  getFile(): Promise<File>
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  readonly kind: 'directory'
  values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandle>
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>
}

interface Window {
  showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
  showOpenFilePicker?: (options?: {
    multiple?: boolean
    types?: { description?: string; accept: Record<string, string[]> }[]
  }) => Promise<FileSystemFileHandle[]>
}
