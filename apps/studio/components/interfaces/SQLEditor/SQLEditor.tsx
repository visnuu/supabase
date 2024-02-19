import { Monaco } from '@monaco-editor/react'
import { useParams, useTelemetryProps } from 'common'
import { motion } from 'framer-motion'
import dynamic from 'next/dynamic'
import { useRouter } from 'next/router'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import Split from 'react-split'
import { format } from 'sql-formatter'

import ConfirmModal from 'components/ui/Dialogs/ConfirmDialog'
import { useSqlEditMutation } from 'data/ai/sql-edit-mutation'
import { useSqlGenerateMutation } from 'data/ai/sql-generate-mutation'
import { useSqlTitleGenerateMutation } from 'data/ai/sql-title-mutation'
import { SqlSnippet } from 'data/content/sql-snippets-query'
import { useEntityDefinitionsQuery } from 'data/database/entity-definitions-query'
import { useReadReplicasQuery } from 'data/read-replicas/replicas-query'
import { useExecuteSqlMutation } from 'data/sql/execute-sql-mutation'
import { useFormatQueryMutation } from 'data/sql/format-sql-query'
import { useOrgSubscriptionQuery } from 'data/subscriptions/org-subscription-query'
import {
  useFlag,
  useLocalStorage,
  useLocalStorageQuery,
  useSelectedOrganization,
  useSelectedProject,
  useStore,
} from 'hooks'
import { IS_PLATFORM, LOCAL_STORAGE_KEYS, OPT_IN_TAGS } from 'lib/constants'
import { uuidv4 } from 'lib/helpers'
import { useProfile } from 'lib/profile'
import { wrapWithRoleImpersonation } from 'lib/role-impersonation'
import Telemetry from 'lib/telemetry'
import { FileDiff } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAppStateSnapshot } from 'state/app-state'
import { useDatabaseSelectorStateSnapshot } from 'state/database-selector'
import { isRoleImpersonationEnabled, useGetImpersonatedRole } from 'state/role-impersonation-state'
import { getSqlEditorStateSnapshot, useSqlEditorStateSnapshot } from 'state/sql-editor'
import { AiIconAnimation, cn } from 'ui'
import { subscriptionHasHipaaAddon } from '../Billing/Subscription/Subscription.utils'
import { AISQLEditorPolicyChat } from './AIPolicyChat'
import AISchemaSuggestionPopover from './AISchemaSuggestionPopover'
import { DiffActionBar } from './DiffActionBar'
import { sqlAiDisclaimerComment, untitledSnippetTitle } from './SQLEditor.constants'
import {
  ContentDiff,
  DiffType,
  IStandaloneCodeEditor,
  IStandaloneDiffEditor,
  SQLEditorContextValues,
} from './SQLEditor.types'
import { checkDestructiveQuery, createSqlSnippetSkeleton } from './SQLEditor.utils'
import UtilityPanel from './UtilityPanel/UtilityPanel'

// Load the monaco editor client-side only (does not behave well server-side)
const MonacoEditor = dynamic(() => import('./MonacoEditor'), { ssr: false })
const DiffEditor = dynamic(
  () => import('@monaco-editor/react').then(({ DiffEditor }) => DiffEditor),
  { ssr: false }
)

const SQLEditorContext = createContext<SQLEditorContextValues | undefined>(undefined)

export function useSqlEditor() {
  const values = useContext(SQLEditorContext)

  if (!values) {
    throw new Error('No SQL editor context. Are you using useSqlEditor() outside of SQLEditor?')
  }

  return values
}

const SQLEditor = () => {
  const { ui } = useStore()
  const { ref, id: urlId } = useParams()
  const router = useRouter()
  const telemetryProps = useTelemetryProps()

  // generate an id to be used for new snippets. The dependency on urlId is to avoid a bug which
  // shows up when clicking on the SQL Editor while being in the SQL editor on a random snippet.
  const generatedId = useMemo(() => uuidv4(), [urlId])
  // the id is stable across renders - it depends either on the url or on the memoized generated id
  const id = !urlId || urlId === 'new' ? generatedId : urlId

  const { profile } = useProfile()
  const project = useSelectedProject()
  const organization = useSelectedOrganization()
  const appSnap = useAppStateSnapshot()
  const snap = useSqlEditorStateSnapshot()
  const databaseSelectorState = useDatabaseSelectorStateSnapshot()

  const { mutate: formatQuery } = useFormatQueryMutation()
  const { mutateAsync: generateSql, isLoading: isGenerateSqlLoading } = useSqlGenerateMutation()
  const { mutateAsync: editSql, isLoading: isEditSqlLoading } = useSqlEditMutation()
  const { mutateAsync: titleSql } = useSqlTitleGenerateMutation()
  const { mutateAsync: generateSqlTitle } = useSqlTitleGenerateMutation()

  const [aiInput, setAiInput] = useState('')
  const [debugSolution, setDebugSolution] = useState<string>()
  const [sqlDiff, setSqlDiff] = useState<ContentDiff>()
  const [pendingTitle, setPendingTitle] = useState<string>()
  const [hasSelection, setHasSelection] = useState<boolean>(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const readReplicasEnabled = useFlag('readReplicas')
  const showReadReplicasUI = readReplicasEnabled && project?.is_read_replicas_enabled

  const { data: subscription } = useOrgSubscriptionQuery({ orgSlug: organization?.slug })
  const { data: databases, isSuccess: isSuccessReadReplicas } = useReadReplicasQuery({
    projectRef: ref,
  })

  // Customers on HIPAA plans should not have access to Supabase AI
  const hasHipaaAddon = subscriptionHasHipaaAddon(subscription)

  const [isAiOpen, setIsAiOpen] = useLocalStorageQuery('supabase_sql-editor-ai-open', true)
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false)

  const selectedOrganization = useSelectedOrganization()
  const selectedProject = useSelectedProject()
  const isOptedInToAI = selectedOrganization?.opt_in_tags?.includes(OPT_IN_TAGS.AI_SQL) ?? false
  const [hasEnabledAISchema] = useLocalStorageQuery('supabase_sql-editor-ai-schema-enabled', true)
  const [isAcceptDiffLoading, setIsAcceptDiffLoading] = useState(false)
  const [, setAiQueryCount] = useLocalStorageQuery('supabase_sql-editor-ai-query-count', 0)
  const [, setIsSchemaSuggestionDismissed] = useLocalStorageQuery(
    'supabase_sql-editor-ai-schema-suggestion-dismissed',
    false
  )

  const includeSchemaMetadata = (isOptedInToAI || !IS_PLATFORM) && hasEnabledAISchema

  const [selectedDiffType, setSelectedDiffType] = useState(DiffType.Modification)
  const [isFirstRender, setIsFirstRender] = useState(true)
  const [lineHighlights, setLineHighlights] = useState<string[]>([])

  const isAiLoading = isGenerateSqlLoading || isEditSqlLoading

  // Used for cleaner framer motion transitions
  useEffect(() => {
    setIsFirstRender(false)
  }, [])

  useEffect(() => {
    if (isSuccessReadReplicas) {
      const primaryDatabase = databases.find((db) => db.identifier === ref)
      databaseSelectorState.setSelectedDatabaseId(primaryDatabase?.identifier)
    }
  }, [isSuccessReadReplicas, databases, ref])

  const { data, refetch: refetchEntityDefinitions } = useEntityDefinitionsQuery(
    {
      projectRef: selectedProject?.ref,
      connectionString: selectedProject?.connectionString,
    },
    { enabled: includeSchemaMetadata }
  )

  const entityDefinitions = includeSchemaMetadata ? data?.map((def) => def.sql.trim()) : undefined

  const isDiffOpen = !!sqlDiff

  const [savedSplitSize, setSavedSplitSize] = useLocalStorage(
    LOCAL_STORAGE_KEYS.SQL_EDITOR_SPLIT_SIZE,
    `[50, 50]`
  )

  const splitSize = savedSplitSize ? JSON.parse(savedSplitSize) : undefined

  const { mutate: execute, isLoading: isExecuting } = useExecuteSqlMutation({
    onSuccess(data) {
      if (id) snap.addResult(id, data.result)

      // Refetching instead of invalidating since invalidate doesn't work with `enabled` flag
      refetchEntityDefinitions()
    },
    onError(error: any) {
      if (id) {
        if (error.position && monacoRef.current) {
          const editor = editorRef.current
          const monaco = monacoRef.current

          const formattedError = error.formattedError ?? ''
          const lineError = formattedError.slice(formattedError.indexOf('LINE'))
          const line = Number(lineError.slice(0, lineError.indexOf(':')).split(' ')[1])

          if (!isNaN(line)) {
            const decorations = editor?.deltaDecorations(
              [],
              [
                {
                  range: new monaco.Range(line, 1, line, 20),
                  options: {
                    isWholeLine: true,
                    inlineClassName: 'bg-warning-400',
                  },
                },
              ]
            )
            if (decorations) {
              editor?.revealLineInCenter(line)
              setLineHighlights(decorations)
            }
          }
        }

        snap.addResultError(id, error)
      }
    },
  })

  const minSize = 44
  const snippet = id ? snap.snippets[id] : null
  const snapOffset = 50

  const isLoading = urlId === 'new' ? false : !(id && ref && snap.loaded[ref])

  const onDragEnd = useCallback(
    (sizes: number[]) => {
      if (id) snap.setSplitSizes(id, sizes)
      setSavedSplitSize(JSON.stringify(sizes))
    },
    [id]
  )

  const editorRef = useRef<IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const diffEditorRef = useRef<IStandaloneDiffEditor | null>(null)

  /**
   * Sets the snippet title using AI.
   */
  const setAiTitle = useCallback(
    async (id: string, sql: string) => {
      const { title } = await generateSqlTitle({ sql })

      snap.renameSnippet(id, title)
    },
    [generateSqlTitle, snap]
  )

  const prettifyQuery = useCallback(async () => {
    if (isDiffOpen) return

    // use the latest state
    const state = getSqlEditorStateSnapshot()
    const snippet = state.snippets[id]

    if (editorRef.current && project) {
      const editor = editorRef.current
      const selection = editor.getSelection()
      const selectedValue = selection ? editor.getModel()?.getValueInRange(selection) : undefined
      const sql = snippet
        ? (selectedValue || editorRef.current?.getValue()) ?? snippet.snippet.content.sql
        : selectedValue || editorRef.current?.getValue()
      formatQuery(
        {
          projectRef: project.ref,
          connectionString: project.connectionString,
          sql,
        },
        {
          onSuccess: (res) => {
            const editorModel = editorRef?.current?.getModel()
            if (editorRef.current && editorModel) {
              editorRef.current.executeEdits('apply-prettify-edit', [
                {
                  text: res.result,
                  range: editorModel.getFullModelRange(),
                },
              ])
              snap.setSql(id, res.result)
            }
          },
        }
      )
    }
  }, [formatQuery, id, isDiffOpen, project, snap])

  const getImpersonatedRole = useGetImpersonatedRole()

  const executeQuery = useCallback(
    async (force: boolean = false) => {
      if (isDiffOpen) return

      // use the latest state
      const state = getSqlEditorStateSnapshot()
      const snippet = state.snippets[id]

      if (editorRef.current !== null && !isExecuting && project !== undefined) {
        const editor = editorRef.current
        const selection = editor.getSelection()
        const selectedValue = selection ? editor.getModel()?.getValueInRange(selection) : undefined

        const sql = snippet
          ? (selectedValue || editorRef.current?.getValue()) ?? snippet.snippet.content.sql
          : selectedValue || editorRef.current?.getValue()

        const containsDestructiveOperations = checkDestructiveQuery(sql)

        if (!force && containsDestructiveOperations) {
          setIsConfirmModalOpen(true)
          return
        }

        if (!hasHipaaAddon && snippet?.snippet.name === untitledSnippetTitle) {
          // Intentionally don't await title gen (lazy)
          setAiTitle(id, sql)
        }

        if (lineHighlights.length > 0) {
          editor?.deltaDecorations(lineHighlights, [])
          setLineHighlights([])
        }

        const impersonatedRole = getImpersonatedRole()
        const connectionString = !showReadReplicasUI
          ? project.connectionString
          : databases?.find((db) => db.identifier === databaseSelectorState.selectedDatabaseId)
              ?.connectionString
        if (IS_PLATFORM && !connectionString) {
          return toast.error('Unable to run query: Connection string is missing')
        }

        execute({
          projectRef: project.ref,
          connectionString: connectionString,
          sql: wrapWithRoleImpersonation(sql, {
            projectRef: project.ref,
            role: impersonatedRole,
          }),
          isRoleImpersonationEnabled: isRoleImpersonationEnabled(impersonatedRole),
        })
      }
    },
    [
      isDiffOpen,
      id,
      isExecuting,
      project,
      hasHipaaAddon,
      execute,
      getImpersonatedRole,
      setAiTitle,
      databaseSelectorState.selectedDatabaseId,
      databases,
    ]
  )

  const handleNewQuery = useCallback(
    async (sql: string, name: string) => {
      if (!ref) return console.error('Project ref is required')

      try {
        const snippet = createSqlSnippetSkeleton({
          id: uuidv4(),
          name,
          sql,
          owner_id: profile?.id,
          project_id: project?.id,
        })
        snap.addSnippet(snippet as SqlSnippet, ref)
        snap.addNeedsSaving(snippet.id!)
        router.push(`/project/${ref}/sql/${snippet.id}`)
      } catch (error: any) {
        ui.setNotification({
          category: 'error',
          message: `Failed to create new query: ${error.message}`,
        })
      }
    },
    [profile?.id, project?.id, ref, router, snap, ui]
  )

  const acceptAiHandler = useCallback(async () => {
    try {
      setIsAcceptDiffLoading(true)

      if (!sqlDiff) {
        return
      }

      // TODO: show error if undefined
      if (!editorRef.current || !diffEditorRef.current) {
        return
      }

      const editorModel = editorRef.current.getModel()
      const diffModel = diffEditorRef.current.getModel()

      if (!editorModel || !diffModel) {
        return
      }

      const sql = diffModel.modified.getValue()

      if (selectedDiffType === DiffType.NewSnippet) {
        const { title } = await titleSql({ sql })
        await handleNewQuery(sql, title)
      } else {
        editorRef.current.executeEdits('apply-ai-edit', [
          {
            text: sql,
            range: editorModel.getFullModelRange(),
          },
        ])

        if (pendingTitle) {
          snap.renameSnippet(id, pendingTitle)
        }
      }

      Telemetry.sendEvent(
        {
          category: 'sql_editor',
          action: 'ai_suggestion_accepted',
          label: debugSolution ? 'debug_snippet' : 'edit_snippet',
        },
        telemetryProps,
        router
      )

      setAiInput('')
      setSelectedDiffType(DiffType.Modification)
      setDebugSolution(undefined)
      setSqlDiff(undefined)
      setPendingTitle(undefined)
    } finally {
      setIsAcceptDiffLoading(false)
    }
  }, [
    sqlDiff,
    selectedDiffType,
    handleNewQuery,
    titleSql,
    debugSolution,
    telemetryProps,
    router,
    id,
    pendingTitle,
    snap,
  ])

  const discardAiHandler = useCallback(() => {
    Telemetry.sendEvent(
      {
        category: 'sql_editor',
        action: 'ai_suggestion_rejected',
        label: debugSolution ? 'debug_snippet' : 'edit_snippet',
      },
      telemetryProps,
      router
    )

    setDebugSolution(undefined)
    setSqlDiff(undefined)
    setPendingTitle(undefined)
  }, [debugSolution, telemetryProps, router])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isDiffOpen) {
        return
      }

      switch (e.key) {
        case 'Enter':
          acceptAiHandler()
          return
        case 'Escape':
          discardAiHandler()
          return
      }
    }

    window.addEventListener('keydown', handler)

    return () => window.removeEventListener('keydown', handler)
  }, [isDiffOpen, acceptAiHandler, discardAiHandler])

  const compareAsModification = useCallback(() => {
    const model = diffEditorRef.current?.getModel()

    if (!model) {
      throw new Error("Diff editor's model not available")
    }

    if (!sqlDiff) {
      throw new Error('Returned SQL diff not available')
    }

    model.original.setValue(sqlDiff.original)
    model.modified.setValue(sqlDiff.modified)
  }, [sqlDiff])

  const compareAsAddition = useCallback(() => {
    const model = diffEditorRef.current?.getModel()

    if (!model) {
      throw new Error("Diff editor's model not available")
    }

    if (!sqlDiff) {
      throw new Error('Returned SQL diff not available')
    }

    const formattedOriginal = sqlDiff.original.replace(sqlAiDisclaimerComment, '').trim()
    const formattedModified = sqlDiff.modified.replace(sqlAiDisclaimerComment, '').trim()
    const newModified =
      sqlAiDisclaimerComment +
      '\n\n' +
      (formattedOriginal ? formattedOriginal + '\n\n' : '') +
      formattedModified

    model.original.setValue(sqlDiff.original)
    model.modified.setValue(newModified)
  }, [sqlDiff])

  const compareAsNewSnippet = useCallback(() => {
    const model = diffEditorRef.current?.getModel()

    if (!model) {
      throw new Error("Diff editor's model not available")
    }

    if (!sqlDiff) {
      throw new Error('Returned SQL diff not available')
    }

    model.original.setValue('')
    model.modified.setValue(sqlDiff.modified)
  }, [sqlDiff])

  return (
    <SQLEditorContext.Provider
      value={{
        aiInput,
        setAiInput,
        sqlDiff,
        setSqlDiff,
        debugSolution,
        setDebugSolution,
      }}
    >
      <ConfirmModal
        visible={isConfirmModalOpen}
        title="Destructive operation"
        danger
        description="We've detected a potentially destructive operation in the query. Please confirm that you would like to execute this query."
        buttonLabel="Run destructive query"
        onSelectCancel={() => {
          setIsConfirmModalOpen(false)
          // [Joshen] Somehow calling this immediately doesn't work, hence the timeout
          setTimeout(() => editorRef.current?.focus(), 100)
        }}
        onSelectConfirm={() => {
          setIsConfirmModalOpen(false)
          executeQuery(true)
        }}
      />
      <div className="flex h-full">
        <div className="flex flex-col relative grow">
          {isDiffOpen && !hasHipaaAddon && (
            <AISchemaSuggestionPopover
              onClickSettings={() => {
                appSnap.setShowAiSettingsModal(true)
              }}
            >
              <motion.div
                key="ask-ai-input-container"
                layoutId="ask-ai-input-container"
                variants={{
                  visible: { borderRadius: 0, x: 0 },
                  hidden: { x: 100 },
                }}
                initial={isFirstRender ? 'visible' : 'hidden'}
                animate="visible"
                className={cn(
                  'w-full z-10 h-[60px] bg-brand-300 border-b border-brand-400 px-5 !border-brand-900 border-none !shadow-none',
                  'flex justify-between items-center gap-3'
                )}
              >
                <div className="flex gap-2 items-center text-foreground-light">
                  <FileDiff className="h-4 w-4" />
                  <span className="text-sm">Accept changes from assistant</span>
                </div>
                <div className="flex flex-row items-center gap-3 mr-1">
                  {isDiffOpen && (
                    <DiffActionBar
                      loading={isAcceptDiffLoading}
                      selectedDiffType={selectedDiffType}
                      onAccept={acceptAiHandler}
                      onChangeDiffType={(diffType) => {
                        setSelectedDiffType(diffType)
                        switch (diffType) {
                          case DiffType.Modification:
                            return compareAsModification()
                          case DiffType.Addition:
                            return compareAsAddition()
                          case DiffType.NewSnippet:
                            return compareAsNewSnippet()
                          default:
                            throw new Error(`Unknown diff type '${diffType}'`)
                        }
                      }}
                      onCancel={discardAiHandler}
                    />
                  )}
                </div>
              </motion.div>
            </AISchemaSuggestionPopover>
          )}
          <Split
            style={{ height: '100%' }}
            direction="vertical"
            gutterSize={2}
            sizes={
              (splitSize ? splitSize : (snippet?.splitSizes as number[] | undefined)) ?? [50, 50]
            }
            minSize={minSize}
            snapOffset={snapOffset}
            expandToMin={true}
            onDragEnd={onDragEnd}
          >
            <div className="flex-grow overflow-y-auto border-b">
              {!isAiOpen && (
                <motion.button
                  layoutId="ask-ai-input-icon"
                  transition={{ duration: 0.1 }}
                  onClick={() => setIsAiOpen(!isAiOpen)}
                  className={cn(
                    'group',
                    'absolute z-10',
                    'rounded-lg',
                    'right-[24px] top-4',
                    'transition-all duration-200',
                    'ease-out'
                  )}
                >
                  <AiIconAnimation loading={false} allowHoverEffect />
                </motion.button>
              )}

              {isLoading ? (
                <div className="flex h-full w-full items-center justify-center">Loading...</div>
              ) : (
                <>
                  {isDiffOpen && (
                    <motion.div
                      className="w-full h-full"
                      variants={{
                        visible: {
                          opacity: 1,
                          filter: 'blur(0px)',
                        },
                        hidden: {
                          opacity: 0,
                          filter: 'blur(10px)',
                        },
                      }}
                      initial="hidden"
                      animate="visible"
                    >
                      <DiffEditor
                        theme="supabase"
                        language="pgsql"
                        original={sqlDiff.original}
                        modified={sqlDiff.modified}
                        onMount={(editor) => {
                          diffEditorRef.current = editor
                          let isFirstLoad = true

                          editor.onDidUpdateDiff(() => {
                            if (!isFirstLoad) {
                              return
                            }

                            const model = editor.getModel()
                            const lineChanges = editor.getLineChanges()

                            if (!model || !lineChanges || lineChanges.length === 0) {
                              return
                            }

                            const original = model.original.getValue()
                            const formattedOriginal = format(
                              original.replace(sqlAiDisclaimerComment, '').trim(),
                              {
                                language: 'postgresql',
                                keywordCase: 'lower',
                              }
                            )
                            const modified = model.modified.getValue()

                            const lineStart = original.includes(sqlAiDisclaimerComment)
                              ? (sqlAiDisclaimerComment + '\n\n').split('\n').length
                              : 0
                            const lineEnd = model.original.getLineCount()
                            const totalLines = lineEnd - lineStart

                            // If any change overwrites >50% of the original code,
                            // and the the modified code doesn't contain the original code,
                            // predict that this is an addition instead of a modification
                            const isAddition =
                              lineChanges.some(
                                (lineChange) =>
                                  lineChange.originalEndLineNumber -
                                    lineChange.originalStartLineNumber >
                                  totalLines * 0.5
                              ) && !modified.includes(formattedOriginal)

                            if (isAddition) {
                              setSelectedDiffType(DiffType.Addition)
                              compareAsAddition()
                            }

                            isFirstLoad = false
                          })
                        }}
                        options={{
                          fontSize: 13,
                        }}
                      />
                    </motion.div>
                  )}
                  <motion.div
                    key={id}
                    variants={{
                      visible: {
                        opacity: 1,
                        filter: 'blur(0px)',
                      },
                      hidden: {
                        opacity: 0,
                        filter: 'blur(10px)',
                      },
                    }}
                    initial="hidden"
                    animate={isDiffOpen ? 'hidden' : 'visible'}
                    className="w-full h-full"
                  >
                    <MonacoEditor
                      autoFocus
                      id={id}
                      editorRef={editorRef}
                      monacoRef={monacoRef}
                      executeQuery={executeQuery}
                      onHasSelection={setHasSelection}
                    />
                  </motion.div>
                </>
              )}
            </div>
            <div className="flex flex-col">
              {isLoading ? (
                <div className="flex h-full w-full items-center justify-center">Loading...</div>
              ) : (
                <UtilityPanel
                  id={id}
                  isExecuting={isExecuting}
                  isDisabled={isDiffOpen}
                  hasSelection={hasSelection}
                  prettifyQuery={prettifyQuery}
                  executeQuery={executeQuery}
                />
              )}
            </div>
          </Split>
        </div>
        {isAiOpen && (
          <AISQLEditorPolicyChat
            messages={[]}
            loading={false}
            onSubmit={function (s: string): void {
              throw new Error('Function not implemented.')
            }}
            onDiff={function (s: string): void {
              throw new Error('Function not implemented.')
            }}
            onChange={() => {}}
          />
        )}
      </div>
    </SQLEditorContext.Provider>
  )
}

export default SQLEditor
