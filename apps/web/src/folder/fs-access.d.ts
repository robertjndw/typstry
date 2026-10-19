// What lib.dom lacks of the File System Access API (Chromium only). The
// directory handle's async iteration and createWritable are already there.
export {};

declare global {
  type FileSystemPermissionMode = "read" | "readwrite";

  interface FileSystemHandle {
    queryPermission(descriptor?: {
      mode?: FileSystemPermissionMode;
    }): Promise<PermissionState>;
    requestPermission(descriptor?: {
      mode?: FileSystemPermissionMode;
    }): Promise<PermissionState>;
  }

  interface DirectoryPickerOptions {
    mode?: FileSystemPermissionMode;
    id?: string;
    startIn?: FileSystemHandle | string;
  }

  interface Window {
    showDirectoryPicker?(
      options?: DirectoryPickerOptions,
    ): Promise<FileSystemDirectoryHandle>;
  }

  type FileSystemChangeType =
    "appeared" | "disappeared" | "modified" | "moved" | "unknown" | "errored";

  interface FileSystemChangeRecord {
    readonly type: FileSystemChangeType;
    readonly relativePathComponents: string[];
    readonly changedHandle: FileSystemHandle | null;
    readonly root: FileSystemHandle;
  }

  class FileSystemObserver {
    constructor(
      callback: (
        records: FileSystemChangeRecord[],
        observer: FileSystemObserver,
      ) => void,
    );
    observe(
      handle: FileSystemHandle,
      options?: { recursive?: boolean },
    ): Promise<void>;
    disconnect(): void;
  }
}
