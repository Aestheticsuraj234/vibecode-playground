"use client"

import type React from "react"
import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar"
import { TemplateFileTree } from "@/features/playground/components/playground-explorer"
import type { TemplateFile } from "@/features/playground/libs/path-to-json"
import { useParams } from "next/navigation"
import { getPlaygroundById, SaveUpdatedCode } from "@/features/playground/actions"
import { toast } from "sonner"
import { FileText, FolderOpen, AlertCircle, Save, X, Settings } from "lucide-react"
import Editor, { type Monaco } from "@monaco-editor/react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import WebContainerPreview from "@/features/webcontainers/components/webcontainer-preveiw"
import { useWebContainer } from "@/features/webcontainers/hooks/useWebContainer"
import { findFilePath } from "@/features/playground/libs"
import LoadingStep from "@/components/ui/loader"
import { configureMonaco, defaultEditorOptions, getEditorLanguage } from "@/features/playground/libs/editor-config"
import dynamic from "next/dynamic"

// Dynamically import Terminal component to avoid SSR issues
const TerminalComponent = dynamic(() => import("@/features/webcontainers/components/terminal"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full text-muted-foreground">Loading terminal...</div>
  ),
})

interface PlaygroundData {
  id: string
  name?: string
  [key: string]: any
}

export interface TemplateFolder {
  folderName: string
  items: (TemplateFile | TemplateFolder)[]
}

interface OpenFile extends TemplateFile {
  id: string
  hasUnsavedChanges: boolean
  content: string
  originalContent: string
}

interface ConfirmationDialog {
  isOpen: boolean
  title: string
  description: string
  onConfirm: () => void
  onCancel: () => void
}

const MainPlaygroundPage: React.FC = () => {
  const { id } = useParams<{ id: string }>()

  // Core state
  const [playgroundData, setPlaygroundData] = useState<PlaygroundData | null>(null)
  const [templateData, setTemplateData] = useState<TemplateFolder | null>(null)
  const [loadingStep, setLoadingStep] = useState<number>(1)
  const [error, setError] = useState<string | null>(null)

  // Multi-file editor state
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeFileId, setActiveFileId] = useState<string | null>(null)
  const [editorContent, setEditorContent] = useState<string>("")

  // UI state
  const [confirmationDialog, setConfirmationDialog] = useState<ConfirmationDialog>({
    isOpen: false,
    title: "",
    description: "",
    onConfirm: () => {},
    onCancel: () => {},
  })
  const [isTerminalVisible, setIsTerminalVisible] = useState(false)
  const [isPreviewVisible, setIsPreviewVisible] = useState(true)

  // Refs
  const editorRef = useRef<any>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const lastSyncedContent = useRef<Map<string, string>>(new Map())

  // Memoize templateData to prevent unnecessary WebContainer reinitializations
  const stableTemplateData = useMemo(() => templateData, [templateData])

  const {
    serverUrl,
    isLoading,
    error: containerError,
    instance,
    writeFileSync,
  } = useWebContainer({
    // @ts-ignore
    templateData: stableTemplateData,
  })

  // Helper function to generate unique file ID
  const generateFileId = (file: TemplateFile): string => {
    return `${file.filename}.${file.fileExtension}`
  }

  // Get active file
  const activeFile = openFiles.find((file) => file.id === activeFileId)

  // Check if there are any unsaved changes
  const hasUnsavedChanges = openFiles.some((file) => file.hasUnsavedChanges)

  // Debounced sync to WebContainer
  const syncToWebContainer = useCallback(
    async (file: OpenFile) => {
      if (!templateData || !writeFileSync) return

      const path = findFilePath(file, templateData)
      if (!path) return

      const lastSynced = lastSyncedContent.current.get(file.id)
      if (lastSynced === file.content) return

      try {
        await writeFileSync(path, file.content)
        lastSyncedContent.current.set(file.id, file.content)
        console.log(`Synced ${file.filename}.${file.fileExtension} to WebContainer`)
      } catch (error) {
        console.error("Failed to sync file to WebContainer:", error)
      }
    },
    [templateData, writeFileSync],
  )

  // Debounced sync function
  const debouncedSync = useCallback(
    (file: OpenFile) => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current)
      }
      syncTimeoutRef.current = setTimeout(() => {
        syncToWebContainer(file)
      }, 500)
    },
    [syncToWebContainer],
  )

  // Auto-save functionality
  const scheduleAutoSave = useCallback(() => {
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current)
    }
    autoSaveTimeoutRef.current = setTimeout(() => {
      if (activeFile && activeFile.hasUnsavedChanges) {
        handleSave(activeFile.id)
      }
    }, 3000)
  }, [activeFile])

  // Fetch playground data
  const fetchPlaygroundTemplateData = async () => {
    if (!id) return
    try {
      setLoadingStep(1)
      setError(null)
      const data = await getPlaygroundById(id)
      // @ts-ignore
      setPlaygroundData(data)
      const rawContent = data?.templateFiles?.[0]?.content
      if (typeof rawContent === "string") {
        const parsedContent = JSON.parse(rawContent)
        setTemplateData(parsedContent)
        setLoadingStep(3)
        toast.success("Loaded template from saved content")
        return
      }
      setLoadingStep(2)
      toast.success("Playground metadata loaded")
      await loadTemplate()
    } catch (error) {
      console.error("Error loading playground:", error)
      setError("Failed to load playground data")
      toast.error("Failed to load playground data")
    }
  }

  const loadTemplate = async () => {
    if (!id) return
    try {
      setLoadingStep(2)
      const res = await fetch(`/api/template/${id}`)
      if (!res.ok) throw new Error(`Failed to load template: ${res.status}`)
      const data = await res.json()
      if (data.templateJson && Array.isArray(data.templateJson)) {
        setTemplateData({
          folderName: "Root",
          items: data.templateJson,
        })
      } else {
        setTemplateData(
          data.templateJson || {
            folderName: "Root",
            items: [],
          },
        )
      }
      setLoadingStep(3)
      toast.success("Template loaded successfully")
    } catch (error) {
      console.error("Error loading template:", error)
      setError("Failed to load template data")
      toast.error("Failed to load template data")
    }
  }

  // File management functions
  const openFile = (file: TemplateFile) => {
    const fileId = generateFileId(file)
    const existingFile = openFiles.find((f) => f.id === fileId)

    if (existingFile) {
      setActiveFileId(fileId)
      setEditorContent(existingFile.content)
    } else {
      const newOpenFile: OpenFile = {
        ...file,
        id: fileId,
        hasUnsavedChanges: false,
        content: file.content || "",
        originalContent: file.content || "",
      }
      setOpenFiles((prev) => [...prev, newOpenFile])
      setActiveFileId(fileId)
      setEditorContent(file.content || "")
    }
  }

  const closeFile = (fileId: string) => {
    const file = openFiles.find((f) => f.id === fileId)
    if (file && file.hasUnsavedChanges) {
      setConfirmationDialog({
        isOpen: true,
        title: "Unsaved Changes",
        description: `You have unsaved changes in ${file.filename}.${file.fileExtension}. Do you want to save before closing?`,
        onConfirm: async () => {
          await handleSave(fileId)
          closeFileForce(fileId)
          setConfirmationDialog((prev) => ({ ...prev, isOpen: false }))
        },
        onCancel: () => {
          closeFileForce(fileId)
          setConfirmationDialog((prev) => ({ ...prev, isOpen: false }))
        },
      })
    } else {
      closeFileForce(fileId)
    }
  }

  const closeFileForce = (fileId: string) => {
    setOpenFiles((prev) => {
      const newFiles = prev.filter((f) => f.id !== fileId)
      if (activeFileId === fileId) {
        const newActiveFile = newFiles[newFiles.length - 1]
        setActiveFileId(newActiveFile?.id || null)
        setEditorContent(newActiveFile?.content || "")
      }
      return newFiles
    })
    lastSyncedContent.current.delete(fileId)
  }

  const closeAllFiles = () => {
    const unsavedFiles = openFiles.filter((f) => f.hasUnsavedChanges)
    if (unsavedFiles.length > 0) {
      setConfirmationDialog({
        isOpen: true,
        title: "Unsaved Changes",
        description: `You have unsaved changes in ${unsavedFiles.length} file(s). Do you want to save all before closing?`,
        onConfirm: async () => {
          await Promise.all(unsavedFiles.map((f) => handleSave(f.id)))
          setOpenFiles([])
          setActiveFileId(null)
          setEditorContent("")
          lastSyncedContent.current.clear()
          setConfirmationDialog((prev) => ({ ...prev, isOpen: false }))
        },
        onCancel: () => {
          setOpenFiles([])
          setActiveFileId(null)
          setEditorContent("")
          lastSyncedContent.current.clear()
          setConfirmationDialog((prev) => ({ ...prev, isOpen: false }))
        },
      })
    } else {
      setOpenFiles([])
      setActiveFileId(null)
      setEditorContent("")
      lastSyncedContent.current.clear()
    }
  }

  const handleFileSelect = (file: TemplateFile) => {
    openFile(file)
  }

  const handleAddFile = (newFile: TemplateFile, parentPath: string) => {
    if (!templateData) return
    const updatedTemplateData = JSON.parse(JSON.stringify(templateData)) as TemplateFolder

    if (!parentPath) {
      updatedTemplateData.items.push(newFile)
      setTemplateData(updatedTemplateData)
      toast.success(`Created file: ${newFile.filename}.${newFile.fileExtension}`)
      openFile(newFile)
      return
    }

    const pathParts = parentPath.split("/")
    let currentFolder = updatedTemplateData
    for (const part of pathParts) {
      const folder = currentFolder.items.find((item) => "folderName" in item && item.folderName === part) as
        | TemplateFolder
        | undefined
      if (!folder) {
        toast.error(`Folder not found: ${part}`)
        return
      }
      currentFolder = folder
    }
    currentFolder.items.push(newFile)
    setTemplateData(updatedTemplateData)
    toast.success(`Created file: ${newFile.filename}.${newFile.fileExtension}`)
    openFile(newFile)
  }

  const handleAddFolder = (newFolder: TemplateFolder, parentPath: string) => {
    if (!templateData) return
    const updatedTemplateData = JSON.parse(JSON.stringify(templateData)) as TemplateFolder

    if (!parentPath) {
      updatedTemplateData.items.push(newFolder)
      setTemplateData(updatedTemplateData)
      toast.success(`Created folder: ${newFolder.folderName}`)
      return
    }

    const pathParts = parentPath.split("/")
    let currentFolder = updatedTemplateData
    for (const part of pathParts) {
      const folder = currentFolder.items.find((item) => "folderName" in item && item.folderName === part) as
        | TemplateFolder
        | undefined
      if (!folder) {
        toast.error(`Folder not found: ${part}`)
        return
      }
      currentFolder = folder
    }
    currentFolder.items.push(newFolder)
    setTemplateData(updatedTemplateData)
    toast.success(`Created folder: ${newFolder.folderName}`)
  }

  const handleDeleteFile = async (file: TemplateFile, parentPath: string) => {
    if (!templateData || !id) return

    // Check if file is currently open and close it
    const fileId = generateFileId(file)
    const isOpen = openFiles.some((f) => f.id === fileId)
    if (isOpen) {
      closeFileForce(fileId)
    }

    const updatedTemplateData = JSON.parse(JSON.stringify(templateData)) as TemplateFolder

    const deleteFromItems = (items: (TemplateFile | TemplateFolder)[]): (TemplateFile | TemplateFolder)[] => {
      return items
        .filter((item) => {
          if ("folderName" in item) {
            return true // Keep folders, but process their contents
          } else {
            // Remove the file if it matches
            return !(item.filename === file.filename && item.fileExtension === file.fileExtension)
          }
        })
        .map((item) => {
          if ("folderName" in item) {
            return {
              ...item,
              items: deleteFromItems(item.items),
            }
          }
          return item
        })
    }

    if (!parentPath) {
      updatedTemplateData.items = deleteFromItems(updatedTemplateData.items)
    } else {
      const pathParts = parentPath.split("/")
      let currentFolder = updatedTemplateData
      for (const part of pathParts) {
        const folder = currentFolder.items.find((item) => "folderName" in item && item.folderName === part) as
          | TemplateFolder
          | undefined
        if (!folder) {
          toast.error(`Folder not found: ${part}`)
          return
        }
        currentFolder = folder
      }
      currentFolder.items = currentFolder.items.filter((item) => {
        if ("folderName" in item) {
          return true
        } else {
          return !(item.filename === file.filename && item.fileExtension === file.fileExtension)
        }
      })
    }

    try {
      // Delete the file from WebContainer if it exists
      if (instance) {
        const filePath = findFilePath(file, templateData)
        if (filePath) {
          try {
            // Use WebContainer's filesystem API to remove the file
            await instance.fs.rm(filePath)
          } catch (error) {
            console.error("Failed to delete file from WebContainer:", error)
          }
        }
      }

      // Save the updated template data to the database
      await SaveUpdatedCode(id, updatedTemplateData)

      // Update local state
      setTemplateData(updatedTemplateData)
      toast.success(`Deleted file: ${file.filename}.${file.fileExtension}`)
    } catch (error) {
      console.error("Error deleting file:", error)
      toast.error("Failed to delete file")
    }
  }

  const handleDeleteFolder = async (folder: TemplateFolder, parentPath: string) => {
    if (!templateData || !id) return

    // Close any open files from this folder
    const folderPath = parentPath ? `${parentPath}/${folder.folderName}` : folder.folderName
    const filesToClose = openFiles.filter((file) => {
      const filePath = findFilePath(file, templateData)
      return filePath?.startsWith(folderPath)
    })

    filesToClose.forEach((file) => closeFileForce(file.id))

    const updatedTemplateData = JSON.parse(JSON.stringify(templateData)) as TemplateFolder

    if (!parentPath) {
      updatedTemplateData.items = updatedTemplateData.items.filter((item) => {
        if ("folderName" in item) {
          return item.folderName !== folder.folderName
        }
        return true
      })
    } else {
      const pathParts = parentPath.split("/")
      let currentFolder = updatedTemplateData
      for (const part of pathParts) {
        const targetFolder = currentFolder.items.find((item) => "folderName" in item && item.folderName === part) as
          | TemplateFolder
          | undefined
        if (!targetFolder) {
          toast.error(`Folder not found: ${part}`)
          return
        }
        currentFolder = targetFolder
      }
      currentFolder.items = currentFolder.items.filter((item) => {
        if ("folderName" in item) {
          return item.folderName !== folder.folderName
        }
        return true
      })
    }

    try {
      // Delete the folder from WebContainer if it exists
      if (instance) {
        const folderPathInContainer = parentPath ? `${parentPath}/${folder.folderName}` : folder.folderName
        try {
          // Use WebContainer's filesystem API to remove the directory recursively
          await instance.fs.rm(folderPathInContainer, { recursive: true })
        } catch (error) {
          console.error("Failed to delete folder from WebContainer:", error)
        }
      }

      // Save the updated template data to the database
      await SaveUpdatedCode(id, updatedTemplateData)

      // Update local state
      setTemplateData(updatedTemplateData)
      toast.success(`Deleted folder: ${folder.folderName}`)
    } catch (error) {
      console.error("Error deleting folder:", error)
      toast.error("Failed to delete folder")
    }
  }

  const handleRenameFile = async (
    file: TemplateFile,
    newFilename: string,
    newExtension: string,
    parentPath: string,
  ) => {
    if (!templateData || !id) return

    const oldFileId = generateFileId(file)
    const newFile = { ...file, filename: newFilename, fileExtension: newExtension }
    const newFileId = generateFileId(newFile)

    // Update open files if this file is open
    const isOpen = openFiles.some((f) => f.id === oldFileId)
    if (isOpen) {
      setOpenFiles((prev) =>
        prev.map((f) => {
          if (f.id === oldFileId) {
            return { ...f, ...newFile, id: newFileId }
          }
          return f
        }),
      )

      if (activeFileId === oldFileId) {
        setActiveFileId(newFileId)
      }

      // Update sync tracking
      const content = lastSyncedContent.current.get(oldFileId)
      if (content) {
        lastSyncedContent.current.set(newFileId, content)
        lastSyncedContent.current.delete(oldFileId)
      }
    }

    const updatedTemplateData = JSON.parse(JSON.stringify(templateData)) as TemplateFolder

    const updateFileInItems = (items: (TemplateFile | TemplateFolder)[]): (TemplateFile | TemplateFolder)[] => {
      return items.map((item) => {
        if ("folderName" in item) {
          return {
            ...item,
            items: updateFileInItems(item.items),
          }
        } else {
          if (item.filename === file.filename && item.fileExtension === file.fileExtension) {
            return { ...item, filename: newFilename, fileExtension: newExtension }
          }
          return item
        }
      })
    }

    if (!parentPath) {
      updatedTemplateData.items = updateFileInItems(updatedTemplateData.items)
    } else {
      const pathParts = parentPath.split("/")
      let currentFolder = updatedTemplateData
      for (const part of pathParts) {
        const folder = currentFolder.items.find((item) => "folderName" in item && item.folderName === part) as
          | TemplateFolder
          | undefined
        if (!folder) {
          toast.error(`Folder not found: ${part}`)
          return
        }
        currentFolder = folder
      }
      currentFolder.items = updateFileInItems(currentFolder.items)
    }

    try {
      // Handle WebContainer file rename
      if (instance) {
        const oldPath = findFilePath(file, templateData)
        if (oldPath) {
          const pathParts = oldPath.split("/")
          pathParts.pop() // Remove the filename
          const dirPath = pathParts.join("/")
          const newPath = dirPath ? `${dirPath}/${newFilename}.${newExtension}` : `${newFilename}.${newExtension}`

          try {
            // Get the content of the old file
            const fileContent = file.content

            // Write the content to the new file
            await writeFileSync(newPath, fileContent)

            // Delete the old file
            await instance.fs.rm(oldPath)
          } catch (error) {
            console.error("Failed to rename file in WebContainer:", error)
          }
        }
      }

      // Save the updated template data to the database
      await SaveUpdatedCode(id, updatedTemplateData)

      // Update local state
      setTemplateData(updatedTemplateData)
      toast.success(`Renamed file to: ${newFilename}.${newExtension}`)
    } catch (error) {
      console.error("Error renaming file:", error)
      toast.error("Failed to rename file")
    }
  }

  const handleRenameFolder = async (folder: TemplateFolder, newFolderName: string, parentPath: string) => {
    if (!templateData || !id) return

    const updatedTemplateData = JSON.parse(JSON.stringify(templateData)) as TemplateFolder

    if (!parentPath) {
      updatedTemplateData.items = updatedTemplateData.items.map((item) => {
        if ("folderName" in item && item.folderName === folder.folderName) {
          return { ...item, folderName: newFolderName }
        }
        return item
      })
    } else {
      const pathParts = parentPath.split("/")
      let currentFolder = updatedTemplateData
      for (const part of pathParts) {
        const targetFolder = currentFolder.items.find((item) => "folderName" in item && item.folderName === part) as
          | TemplateFolder
          | undefined
        if (!targetFolder) {
          toast.error(`Folder not found: ${part}`)
          return
        }
        currentFolder = targetFolder
      }
      currentFolder.items = currentFolder.items.map((item) => {
        if ("folderName" in item && item.folderName === folder.folderName) {
          return { ...item, folderName: newFolderName }
        }
        return item
      })
    }

    try {
      // Handle WebContainer folder rename - this is more complex as we need to move all files
      if (instance) {
        const oldFolderPath = parentPath ? `${parentPath}/${folder.folderName}` : folder.folderName
        const newFolderPath = parentPath ? `${parentPath}/${newFolderName}` : newFolderName

        try {
          // Create the new folder
          await instance.fs.mkdir(newFolderPath, { recursive: true })

          // We would need to recursively copy all files from old folder to new folder
          // This is complex and would require a recursive function to traverse the folder structure
          // For simplicity, we'll just update the database and let the WebContainer reinitialize
          // on the next page load with the correct structure
        } catch (error) {
          console.error("Failed to rename folder in WebContainer:", error)
        }
      }

      // Save the updated template data to the database
      await SaveUpdatedCode(id, updatedTemplateData)

      // Update local state
      setTemplateData(updatedTemplateData)
      toast.success(`Renamed folder to: ${newFolderName}`)
    } catch (error) {
      console.error("Error renaming folder:", error)
      toast.error("Failed to rename folder")
    }
  }

  // Editor functions
  const handleEditorDidMount = (editor: any, monaco: Monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    editor.updateOptions(defaultEditorOptions)
    configureMonaco(monaco)

    setTimeout(() => {
      updateEditorLanguage()
    }, 100)
  }

  const updateEditorLanguage = () => {
    if (!activeFile || !monacoRef.current || !editorRef.current) return

    const model = editorRef.current.getModel()
    if (!model) return

    const language = getEditorLanguage(activeFile.fileExtension || "")

    try {
      monacoRef.current.editor.setModelLanguage(model, language)
    } catch (error) {
      console.warn("Failed to set editor language:", error)
    }
  }

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined && activeFile) {
      setEditorContent(value)

      setOpenFiles((prev) =>
        prev.map((file) => {
          if (file.id === activeFile.id) {
            const updatedFile = {
              ...file,
              content: value,
              hasUnsavedChanges: value !== file.originalContent,
            }

            debouncedSync(updatedFile)
            return updatedFile
          }
          return file
        }),
      )

      scheduleAutoSave()
    }
  }

  // Save functions
  const handleSave = async (fileId?: string) => {
    const targetFileId = fileId || activeFileId
    if (!targetFileId || !templateData) return

    const fileToSave = openFiles.find((f) => f.id === targetFileId)
    if (!fileToSave) return

    try {
      const updatedTemplateData: TemplateFolder = JSON.parse(JSON.stringify(templateData))

      const updateFileContent = (items: (TemplateFile | TemplateFolder)[]): (TemplateFile | TemplateFolder)[] => {
        return items.map((item) => {
          if ("folderName" in item) {
            return {
              ...item,
              items: updateFileContent(item.items),
            }
          } else {
            if (item.filename === fileToSave.filename && item.fileExtension === fileToSave.fileExtension) {
              return {
                ...item,
                content: fileToSave.content,
              }
            }
            return item
          }
        })
      }

      updatedTemplateData.items = updateFileContent(updatedTemplateData.items)
      setTemplateData(updatedTemplateData)

      const path = findFilePath(fileToSave, updatedTemplateData)
      if (path && writeFileSync) {
        await writeFileSync(path, fileToSave.content)
        lastSyncedContent.current.set(fileToSave.id, fileToSave.content)
      }

      await SaveUpdatedCode(id, updatedTemplateData)

      setOpenFiles((prev) =>
        prev.map((file) =>
          file.id === targetFileId
            ? {
                ...file,
                hasUnsavedChanges: false,
                originalContent: file.content,
              }
            : file,
        ),
      )

      toast.success(`Saved ${fileToSave.filename}.${fileToSave.fileExtension}`)
    } catch (error) {
      console.error("Error saving file:", error)
      toast.error("Failed to save file")
    }
  }

  const handleSaveAll = async () => {
    const unsavedFiles = openFiles.filter((f) => f.hasUnsavedChanges)
    if (unsavedFiles.length === 0) {
      toast.info("No unsaved changes to save")
      return
    }

    try {
      await Promise.all(unsavedFiles.map((f) => handleSave(f.id)))
      toast.success(`Saved ${unsavedFiles.length} file(s)`)
    } catch (error) {
      toast.error("Failed to save some files")
    }
  }

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey) {
        switch (event.key) {
          case "s":
            event.preventDefault()
            if (event.shiftKey) {
              handleSaveAll()
            } else {
              handleSave()
            }
            break
          case "w":
            event.preventDefault()
            if (activeFileId) {
              closeFile(activeFileId)
            }
            break
          case "n":
            event.preventDefault()
            break
          case "`":
            event.preventDefault()
            setIsTerminalVisible((prev) => !prev)
            break
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [activeFileId])

  // Effects
  useEffect(() => {
    if (id) fetchPlaygroundTemplateData()
  }, [id])

  useEffect(() => {
    if (activeFile) {
      setEditorContent(activeFile.content)
      if (monacoRef.current && editorRef.current) {
        setTimeout(() => {
          updateEditorLanguage()
        }, 50)
      }
    }
  }, [activeFile])

  // Cleanup
  useEffect(() => {
    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current)
      }
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current)
      }
    }
  }, [])

  // Render loading state
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-4rem)] p-4">
        <AlertCircle className="h-12 w-12 text-red-500 mb-4" />
        <h2 className="text-xl font-semibold text-red-600 mb-2">Something went wrong</h2>
        <p className="text-gray-600 mb-4">{error}</p>
        <Button
          onClick={() => {
            setError(null)
            fetchPlaygroundTemplateData()
          }}
          variant="destructive"
        >
          Try Again
        </Button>
      </div>
    )
  }

  if (loadingStep < 3) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-4rem)] p-4">
        <div className="w-full max-w-md p-6 rounded-lg shadow-sm border">
          <h2 className="text-xl font-semibold mb-6 text-center">Loading Playground</h2>
          <div className="mb-8">
            <LoadingStep currentStep={loadingStep} step={1} label="Loading playground metadata" />
            <LoadingStep currentStep={loadingStep} step={2} label="Loading template structure" />
            <LoadingStep currentStep={loadingStep} step={3} label="Ready to explore" />
          </div>
          <div className="w-full h-2 rounded-full overflow-hidden">
            <div
              className="bg-red-600 h-full transition-all duration-300 ease-in-out"
              style={{ width: `${(loadingStep / 3) * 100}%` }}
            />
          </div>
        </div>
      </div>
    )
  }

  if (!templateData) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-4rem)] p-4">
        <FolderOpen className="h-12 w-12 text-amber-500 mb-4" />
        <h2 className="text-xl font-semibold text-amber-600 mb-2">No template data available</h2>
        <p className="text-gray-600 mb-4">The template appears to be empty or in an invalid format</p>
        <Button onClick={loadTemplate} variant="outline">
          Reload Template
        </Button>
      </div>
    )
  }

  return (
    <TooltipProvider>
      <>
        <TemplateFileTree
          data={templateData}
          onFileSelect={handleFileSelect}
          selectedFile={activeFile}
          title="Template Explorer"
          onAddFile={handleAddFile}
          onAddFolder={handleAddFolder}
          onDeleteFile={handleDeleteFile}
          onDeleteFolder={handleDeleteFolder}
          onRenameFile={handleRenameFile}
          onRenameFolder={handleRenameFolder}
        />
        <SidebarInset>
          <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />

            <div className="flex flex-1 items-center gap-2">
              <div className="flex flex-col flex-1">
                <h1 className="text-sm font-medium">{playgroundData?.name || "Code Playground"}</h1>
                <p className="text-xs text-muted-foreground">
                  {openFiles.length} file(s) open
                  {hasUnsavedChanges && " • Unsaved changes"}
                </p>
              </div>

              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      // @ts-ignore
                      onClick={handleSave}
                      disabled={!activeFile || !activeFile.hasUnsavedChanges}
                    >
                      <Save className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Save (Ctrl+S)</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="sm" variant="outline" onClick={handleSaveAll} disabled={!hasUnsavedChanges}>
                      <Save className="h-4 w-4" />
                      All
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Save All (Ctrl+Shift+S)</TooltipContent>
                </Tooltip>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline">
                      <Settings className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setIsPreviewVisible(!isPreviewVisible)}>
                      {isPreviewVisible ? "Hide" : "Show"} Preview
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setIsTerminalVisible(!isTerminalVisible)}>
                      {isTerminalVisible ? "Hide" : "Show"} Terminal
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={closeAllFiles}>Close All Files</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </header>

          <div className="h-[calc(100vh-4rem)]">
            {openFiles.length > 0 ? (
              <div className="h-full flex flex-col">
                {/* File Tabs */}
                <div className="border-b bg-muted/30">
                  <Tabs value={activeFileId || ""} onValueChange={setActiveFileId}>
                    <div className="flex items-center justify-between px-4 py-2">
                      <TabsList className="h-8 bg-transparent p-0">
                        {openFiles.map((file) => (
                          <TabsTrigger
                            key={file.id}
                            value={file.id}
                            className="relative h-8 px-3 data-[state=active]:bg-background data-[state=active]:shadow-sm group"
                          >
                            <div className="flex items-center gap-2 justify-center group">
                              <span className="flex items-center gap-1">
                                <FileText className="h-3 w-3" />
                                <span>
                                  {file.filename}.{file.fileExtension}
                                </span>
                                {file.hasUnsavedChanges && <span className="h-2 w-2 rounded-full bg-orange-500" />}
                              </span>
                              <span
                                className="ml-2 h-4 w-4 hover:bg-destructive hover:text-destructive-foreground rounded-sm flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  closeFile(file.id)
                                }}
                              >
                                <X className="h-3 w-3" />
                              </span>
                            </div>
                          </TabsTrigger>
                        ))}
                      </TabsList>

                      {openFiles.length > 1 && (
                        <Button size="sm" variant="ghost" onClick={closeAllFiles} className="h-6 px-2 text-xs">
                          Close All
                        </Button>
                      )}
                    </div>
                  </Tabs>
                </div>

                {/* Editor and Preview */}
                <div className="flex-1">
                  <ResizablePanelGroup direction="horizontal" className="h-full">
                    <ResizablePanel defaultSize={isPreviewVisible ? 50 : 100}>
                      <div className="h-full flex flex-col">
                        <div className="flex-1">
                          <Editor
                            height="100%"
                            value={editorContent}
                            onChange={handleEditorChange}
                            onMount={handleEditorDidMount}
                            language={activeFile ? getEditorLanguage(activeFile.fileExtension || "") : "plaintext"}
                            // @ts-ignore
                            options={defaultEditorOptions}
                          />
                        </div>

                        {isTerminalVisible && (
                          <>
                            <ResizableHandle />
                            <div className="h-64 border-t">
                              <TerminalComponent webcontainerUrl={serverUrl!} />
                            </div>
                          </>
                        )}
                      </div>
                    </ResizablePanel>

                    {isPreviewVisible && (
                      <>
                        <ResizableHandle />
                        <ResizablePanel defaultSize={50}>
                          <WebContainerPreview
                          // @ts-ignore
                            templateData={stableTemplateData}
                            error={containerError!}
                            instance={instance!}
                            isLoading={isLoading}
                            serverUrl={serverUrl!}
                            writeFileSync={writeFileSync}
                          />
                        </ResizablePanel>
                      </>
                    )}
                  </ResizablePanelGroup>
                </div>
              </div>
            ) : (
              <div className="flex flex-col h-full items-center justify-center text-muted-foreground gap-4">
                <FileText className="h-16 w-16 text-gray-300" />
                <div className="text-center">
                  <p className="text-lg font-medium">No files open</p>
                  <p className="text-sm text-gray-500">Select a file from the sidebar to start editing</p>
                </div>
              </div>
            )}
          </div>
        </SidebarInset>

        {/* Confirmation Dialog */}
        <Dialog
          open={confirmationDialog.isOpen}
          onOpenChange={(open) => setConfirmationDialog((prev) => ({ ...prev, isOpen: open }))}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{confirmationDialog.title}</DialogTitle>
              <DialogDescription>{confirmationDialog.description}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={confirmationDialog.onCancel}>
                Don't Save
              </Button>
              <Button onClick={confirmationDialog.onConfirm}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    </TooltipProvider>
  )
}

export default MainPlaygroundPage
