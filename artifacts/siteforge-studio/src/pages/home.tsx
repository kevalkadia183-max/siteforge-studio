import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useStudio } from '../hooks/use-studio';
import { StudioSidebar } from '../components/studio-sidebar';
import { StudioPreview } from '../components/studio-preview';
import { ExportDialog } from '../components/export-dialog';
import { SharePreviewDialog } from '../components/share-preview-dialog';
import { AccountControl } from '../components/account-control';
import {
  Paintbrush, Eye, Layout, Undo2, Redo2, Loader2, Save,
  FilePlus, Copy, Trash, Folder, Pencil, RotateCcw, Inbox,
  AlertTriangle, RefreshCw, ServerCrash, WifiOff, Users, Mail
} from 'lucide-react';
import { cn } from '../lib/utils';
import { generateSite } from '../lib/generator';
import { PageId, TemplateId } from '../lib/types';
import { SiteProject } from '../lib/types';
import { getDefaultBusinessName, TEMPLATES } from '../lib/templates';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, Button, Input, Label, Select } from '../components/ui/forms';
import { Link } from 'wouter';
import { useToast } from '../hooks/use-toast';

export default function Home() {
  const studio = useStudio();
  const { toast } = useToast();
  const [mobileTab, setMobileTab] = useState<'editor' | 'preview'>('editor');
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectTemplate, setNewProjectTemplate] = useState(TEMPLATES[0].id);
  const [isNewProjectOpen, setIsNewProjectOpen] = useState(false);

  // Rename state – only close input on success
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingProjectName, setEditingProjectName] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);

  // Per-project operation busy guard (prevents duplicate clicks)
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);

  const projectQueryOnceRef = useRef(false);

  useEffect(() => {
    if (!studio.isReady) return;
    if (projectQueryOnceRef.current) return;

    const searchParams = new URLSearchParams(window.location.search);
    const projectId = searchParams.get('project');
    if (projectId) {
      projectQueryOnceRef.current = true;
      if (projectId !== studio.project?.id) {
        setBusyProjectId(projectId);
        studio.switchProject(projectId).then(ok => {
          setBusyProjectId(null);
          if (ok) {
            const newUrl = new URL(window.location.href);
            newUrl.searchParams.delete('project');
            window.history.replaceState({}, '', newUrl.toString());
          } else {
            toast({ title: 'Could not open project', description: 'The requested project could not be found or opened.', variant: 'destructive' });
          }
        });
      } else {
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.delete('project');
        window.history.replaceState({}, '', newUrl.toString());
      }
    } else {
      projectQueryOnceRef.current = true;
    }
  }, [studio.isReady, studio.project?.id, studio.switchProject, toast]);

  const site = useMemo(() => {
    if (!studio.project) return null;
    return generateSite(studio.project);
  }, [studio.project]);

  // ─── Init error screen ────────────────────────────────────────────────────
  if (studio.initError) {
    return (
      <div className="h-dvh w-full flex flex-col items-center justify-center gap-6 bg-background text-foreground px-6">
        <div className="flex flex-col items-center gap-4 max-w-sm text-center">
          <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <WifiOff size={24} className="text-destructive" />
          </div>
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">Could not load studio</h2>
            <p className="text-sm text-muted-foreground" data-testid="init-error-message">
              {studio.initError}
            </p>
          </div>
          <Button onClick={studio.retryInitialization} className="gap-2" data-testid="btn-retry-init">
            <RefreshCw size={16} /> Try again
          </Button>
        </div>
      </div>
    );
  }

  // ─── Loading screen ───────────────────────────────────────────────────────
  if (!studio.isReady || !studio.project || !site) {
    return (
      <div className="h-dvh w-full flex items-center justify-center bg-background text-foreground">
        <Loader2 className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  const p = studio.project;

  // ─── Rename handlers ──────────────────────────────────────────────────────
  const handleRenameSubmit = async (projId: string) => {
    if (isRenaming) return;
    setIsRenaming(true);
    const ok = await studio.renameProject(projId, editingProjectName);
    setIsRenaming(false);
    if (ok) setEditingProjectId(null); // only close on success
  };

  // ─── Duplicate handler ────────────────────────────────────────────────────
  const handleDuplicate = async (proj: SiteProject) => {
    if (busyProjectId) return;
    setBusyProjectId(proj.id);
    await studio.duplicateProject(proj);
    setBusyProjectId(null);
  };

  // ─── Delete handler ───────────────────────────────────────────────────────
  const handleDelete = async (proj: SiteProject) => {
    if (busyProjectId) return;
    if (!window.confirm(`Delete "${proj.name}"? This cannot be undone.`)) return;
    setBusyProjectId(proj.id);
    await studio.deleteProject(proj.id);
    setBusyProjectId(null);
  };

  // ─── Switch handler ───────────────────────────────────────────────────────
  const handleSwitch = async (projId: string) => {
    if (busyProjectId || projId === p.id) return;
    setBusyProjectId(projId);
    await studio.switchProject(projId);
    setBusyProjectId(null);
  };

  return (
    <div className="h-dvh w-full flex flex-col bg-background text-foreground overflow-hidden">
      {/* Topbar */}
      <header className="h-14 border-b border-border flex items-center justify-between px-4 lg:px-6 shrink-0 bg-card z-20">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-primary flex items-center justify-center text-primary-foreground font-bold shadow-sm">
              SF
            </div>
            <span className="font-bold tracking-tight text-lg hidden sm:inline-block">
              SiteForge<span className="text-muted-foreground font-medium">Studio</span>
            </span>
          </div>

          <div className="flex items-center gap-2 md:ml-4 md:pl-4 md:border-l md:border-border">
            <Dialog>
              <DialogTrigger asChild>
                <button
                  className="flex items-center gap-2 text-sm font-medium hover:text-primary transition-colors"
                  aria-label="Open project manager"
                  data-testid="btn-project-menu"
                >
                  <Folder size={16} />
                  <span className="hidden md:inline max-w-44 truncate">{p.name}</span>
                  {studio.projectSiteType === 'prospect' && (
                    <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 text-[10px] uppercase font-bold tracking-wider">
                      Prospect Draft
                    </span>
                  )}
                </button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Projects</DialogTitle>
                </DialogHeader>
                {studio.mutationError && (
                  <div
                    className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                    role="alert"
                    data-testid="mutation-error"
                  >
                    <AlertTriangle size={14} className="shrink-0" />
                    {studio.mutationError}
                  </div>
                )}
                <div className="space-y-4 pt-4">
                  <div className="grid gap-2 max-h-[300px] overflow-y-auto">
                    {studio.projects.map(proj => {
                      const isBusy = busyProjectId === proj.id;
                      return (
                        <div
                          key={proj.id}
                          className={cn(
                            'flex items-center justify-between p-3 rounded-lg border',
                            proj.id === p.id
                              ? 'border-primary bg-primary/5'
                              : 'border-border hover:border-primary/50',
                            isBusy && 'opacity-60 pointer-events-none',
                          )}
                        >
                          {editingProjectId === proj.id ? (
                            <div className="flex-1 flex gap-2 mr-2">
                              <Input
                                aria-label={`Rename ${proj.name}`}
                                value={editingProjectName}
                                onChange={e => setEditingProjectName(e.target.value)}
                                className="h-7 text-sm"
                                autoFocus
                                disabled={isRenaming}
                                onKeyDown={async e => {
                                  if (e.key === 'Enter') await handleRenameSubmit(proj.id);
                                  else if (e.key === 'Escape') setEditingProjectId(null);
                                }}
                              />
                              <Button
                                size="sm"
                                className="h-7 px-2"
                                disabled={isRenaming}
                                onClick={() => handleRenameSubmit(proj.id)}
                              >
                                {isRenaming ? <Loader2 size={12} className="animate-spin" /> : 'Save'}
                              </Button>
                            </div>
                          ) : (
                            <div className="flex-1 overflow-hidden mr-2">
                              <button
                                onClick={() => handleSwitch(proj.id)}
                                className="w-full text-left font-medium text-sm truncate flex flex-col items-start"
                                data-testid={`project-item-${proj.id}`}
                                disabled={isBusy}
                              >
                                <span>{proj.name}</span>
                                {studio.projectSiteTypes?.[proj.id] === 'prospect' && (
                                  <span className="mt-0.5 px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 text-[9px] uppercase font-bold tracking-wider leading-none">
                                    Prospect Draft
                                  </span>
                                )}
                              </button>
                            </div>
                          )}
                          <div className="flex gap-1 shrink-0">
                            <button
                              onClick={() => {
                                setEditingProjectId(proj.id);
                                setEditingProjectName(proj.name);
                              }}
                              className="p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
                              title="Rename"
                              disabled={!!busyProjectId}
                              data-testid={`btn-rename-project-${proj.id}`}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => handleDuplicate(proj)}
                              className="p-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40"
                              title="Duplicate"
                              disabled={!!busyProjectId}
                              data-testid={`btn-duplicate-project-${proj.id}`}
                            >
                              {isBusy ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
                            </button>
                            <button
                              onClick={() => handleDelete(proj)}
                              className="p-1.5 text-muted-foreground hover:text-destructive disabled:opacity-40"
                              title="Delete"
                              disabled={!!busyProjectId}
                              data-testid={`btn-delete-project-${proj.id}`}
                            >
                              {isBusy ? <Loader2 size={14} className="animate-spin" /> : <Trash size={14} />}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <Dialog open={isNewProjectOpen} onOpenChange={setIsNewProjectOpen}>
                    <DialogTrigger asChild>
                      <Button className="w-full gap-2" variant="outline">
                        <FilePlus size={16} /> New Project
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Create New Project</DialogTitle>
                      </DialogHeader>
                      <div className="space-y-4 pt-4">
                        <div className="space-y-2">
                          <Label htmlFor="new-project-name">Project Name (optional)</Label>
                          <Input
                            id="new-project-name"
                            value={newProjectName}
                            onChange={e => setNewProjectName(e.target.value)}
                            placeholder={getDefaultBusinessName(newProjectTemplate)}
                          />
                          <p className="text-xs text-muted-foreground">
                            Leave blank to start with the editable demo business name.
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="new-project-template">Template</Label>
                          <Select
                            id="new-project-template"
                            value={newProjectTemplate}
                            onChange={e => setNewProjectTemplate(e.target.value as TemplateId)}
                          >
                            {TEMPLATES.map(t => (
                              <option key={t.id} value={t.id}>
                                {t.name} - {t.description}
                              </option>
                            ))}
                          </Select>
                        </div>
                        <Button
                          onClick={async () => {
                              const projectName = newProjectName.trim() || getDefaultBusinessName(newProjectTemplate);
                              const ok = await studio.newProject(projectName, newProjectTemplate);
                              if (ok) {
                                setIsNewProjectOpen(false);
                                setNewProjectName('');
                            }
                          }}
                          className="w-full"
                          data-testid="btn-create-project"
                        >
                          Create Project
                        </Button>
                      </div>
                    </DialogContent>
                  </Dialog>

                  <Button
                    className="w-full gap-2"
                    variant="outline"
                    onClick={() => {
                      if (
                        window.confirm(
                          'Reset this project to the selected template defaults? Your current content will be replaced.',
                        )
                      ) {
                        studio.resetProject();
                      }
                    }}
                    data-testid="btn-reset-project"
                  >
                    <RotateCcw size={16} /> Reset current project
                  </Button>
                </div>
              </DialogContent>
            </Dialog>

            <div className="hidden md:flex items-center gap-1 text-muted-foreground ml-2">
              <button
                onClick={studio.undo}
                disabled={!studio.canUndo}
                className="p-1.5 hover:text-foreground disabled:opacity-30 rounded"
                aria-label="Undo last change"
                data-testid="btn-undo"
              >
                <Undo2 size={16} />
              </button>
              <button
                onClick={studio.redo}
                disabled={!studio.canRedo}
                className="p-1.5 hover:text-foreground disabled:opacity-30 rounded"
                aria-label="Redo last change"
                data-testid="btn-redo"
              >
                <Redo2 size={16} />
              </button>
            </div>

            <div
              className="hidden lg:flex items-center gap-1.5 text-xs text-muted-foreground ml-2"
              data-testid="save-status"
            >
              {studio.saveStatus === 'saving' ? (
                <>
                  <Loader2 size={12} className="animate-spin" /> Saving...
                </>
              ) : studio.saveStatus === 'saved' ? (
                <>
                  <Save size={12} /> Saved
                </>
              ) : studio.saveStatus === 'conflict' ? (
                <span className="text-amber-600 flex items-center gap-1">
                  <AlertTriangle size={12} /> Conflict
                </span>
              ) : (
                <span className="text-destructive flex items-center gap-1">
                  <AlertTriangle size={12} /> Save Error
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Right side: page picker + actions + account */}
        <div className="flex items-center gap-2 lg:gap-4">
          <div className="hidden md:flex items-center gap-2 mr-2">
            <Layout size={16} className="text-muted-foreground" />
            <select
              value={p.activePageId}
              onChange={e => studio.setActivePage(e.target.value as PageId)}
              aria-label="Preview page"
              className="bg-transparent text-sm font-medium outline-none cursor-pointer hover:text-primary"
              data-testid="select-page"
            >
              {Object.values(p.pages).map(page => (
                <option key={page.id} value={page.id}>
                  {page.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <SharePreviewDialog project={p} site={site} onBeforePublish={studio.saveNow} />
            <ExportDialog
              site={site}
              businessName={p.business.name}
              hasReceptionist={!!p.receptionist?.enabled && !!p.receptionist?.receptionistId}
              hostedApiUrl={p.receptionist?.hostedApiUrl}
            />
            <Link href="/leads" className="btn btn-outline h-9 px-3 gap-2 flex text-sm items-center">
              <Users size={16} /> Leads
            </Link>
            <Link href="/leads/outreach" className="hidden sm:flex btn btn-outline h-9 px-3 gap-2 text-sm items-center">
              <Mail size={16} /> Outreach
            </Link>
            {p.receptionist?.enabled && p.receptionist?.receptionistId && (
              <Link href="/inbox" className="btn btn-outline h-9 px-3 gap-2 flex text-sm items-center">
                <Inbox size={16} /> Inbox
              </Link>
            )}
          </div>
          {/* Account control: sign-out and user info */}
          <AccountControl />
        </div>
      </header>

      {/* Save error / conflict banners */}
      {studio.saveStatus === 'error' && studio.saveError && (
        <div
          className="flex items-center justify-between gap-4 bg-destructive/10 border-b border-destructive/20 px-4 py-2 text-sm text-destructive"
          role="alert"
          data-testid="save-error-banner"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="shrink-0" />
            <span>Save failed: {studio.saveError}</span>
          </div>
          <button
            className="flex items-center gap-1.5 text-xs font-medium underline underline-offset-2 hover:no-underline"
            onClick={() => studio.retrySave()}
            data-testid="btn-retry-save"
          >
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      )}
      {studio.saveStatus === 'conflict' && studio.conflictState && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 bg-amber-50 border-b border-amber-200 px-4 py-2 text-sm text-amber-800"
          role="alert"
          data-testid="save-conflict-banner"
        >
          <div className="flex items-center gap-2">
            <ServerCrash size={14} className="shrink-0" />
            <span>This project was saved elsewhere. Choose how to resolve:</span>
          </div>
          <div className="flex gap-2">
            <button
              className="flex items-center gap-1.5 rounded border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium hover:bg-amber-50"
              onClick={studio.resolveConflictLoadServer}
              data-testid="btn-conflict-load-server"
            >
              Load server version
            </button>
            <button
              className="flex items-center gap-1.5 rounded bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700"
              onClick={() => studio.resolveConflictOverwrite()}
              data-testid="btn-conflict-overwrite"
            >
              Keep my edits
            </button>
          </div>
        </div>
      )}

      {/* Mobile Tabs */}
      <div className="flex md:hidden border-b border-border bg-card shrink-0">
        <button
          onClick={() => setMobileTab('editor')}
          className={cn(
            'flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 border-b-2 transition-colors',
            mobileTab === 'editor'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
          data-testid="tab-mobile-editor"
        >
          <Paintbrush size={16} /> Edit
        </button>
        <button
          onClick={() => setMobileTab('preview')}
          className={cn(
            'flex-1 py-3 text-sm font-medium flex items-center justify-center gap-2 border-b-2 transition-colors',
            mobileTab === 'preview'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
          data-testid="tab-mobile-preview"
        >
          <Eye size={16} /> Preview
        </button>
      </div>

      {/* Mobile Page Switcher */}
      <div
        className={cn(
          'md:hidden p-3 bg-muted/20 border-b border-border flex items-center justify-between',
          mobileTab === 'editor' ? 'flex' : 'hidden',
        )}
      >
        <span className="text-sm font-medium text-muted-foreground">Editing Page:</span>
        <select
          value={p.activePageId}
          onChange={e => studio.setActivePage(e.target.value as PageId)}
          aria-label="Editing page"
          className="bg-background border border-border rounded px-2 py-1 text-sm outline-none"
        >
          {Object.values(p.pages).map(page => (
            <option key={page.id} value={page.id}>
              {page.name}
            </option>
          ))}
        </select>
      </div>

      {/* Main Studio Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        <div
          className={cn(
            'w-full md:w-[320px] lg:w-[380px] shrink-0 md:block',
            mobileTab === 'editor' ? 'block' : 'hidden',
          )}
        >
          <StudioSidebar
            project={p}
            updateBusiness={studio.updateBusiness}
            updateTokens={studio.updateTokens}
            updateSection={studio.updateSection}
            applyBriefDraft={studio.applyBriefDraft}
            moveSection={studio.moveSection}
            toggleSectionVisibility={studio.toggleSectionVisibility}
            switchTemplate={studio.switchTemplate}
            updateReceptionist={studio.updateReceptionist}
          />
        </div>

        {/* Preview Area */}
        <div
          className={cn(
            'flex-1 relative md:block',
            mobileTab === 'preview' ? 'block' : 'hidden',
          )}
        >
          <StudioPreview
            site={site}
            activePageId={p.activePageId}
            device={device}
            onDeviceChange={setDevice}
          />
        </div>
      </div>
    </div>
  );
}
