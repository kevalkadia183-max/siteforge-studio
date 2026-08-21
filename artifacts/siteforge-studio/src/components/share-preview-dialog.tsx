import { useEffect, useMemo, useState } from 'react';
import {
  publishPreview,
  refreshPreview,
  revokePreview,
  type PreviewPublication,
} from '@workspace/api-client-react';
import {
  Check,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  RefreshCw,
  ShieldOff,
} from 'lucide-react';
import type { GeneratedSite } from '../lib/generator';
import type { SiteProject } from '../lib/types';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
} from './ui/forms';

const STORAGE_KEY = 'siteforge_preview_publications';
const EDITOR_KEY = 'siteforge_editor_key';

type StoredPublications = Record<string, PreviewPublication>;
type Action = 'publish' | 'refresh' | 'revoke' | null;

function readPublications(): StoredPublications {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as StoredPublications;
  } catch {
    return {};
  }
}

function getEditorKey(): string {
  const existing = localStorage.getItem(EDITOR_KEY);
  if (existing && existing.length >= 32) return existing;
  const next = crypto.randomUUID();
  localStorage.setItem(EDITOR_KEY, next);
  return next;
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'data' in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === 'object' && 'error' in data) {
      const message = (data as { error?: unknown }).error;
      if (typeof message === 'string') return message;
    }
  }
  return error instanceof Error ? error.message : 'The preview service is unavailable.';
}

export function SharePreviewDialog({
  project,
  site,
  onBeforePublish,
}: {
  project: SiteProject;
  site: GeneratedSite;
  /** Async save hook. Must resolve true before publishing. */
  onBeforePublish: () => Promise<boolean>;
}) {
  const [publication, setPublication] = useState<PreviewPublication | null>(null);
  const [action, setAction] = useState<Action>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const editorKey = useMemo(getEditorKey, []);
  const requestOptions = useMemo(
    () => ({ headers: { 'X-SiteForge-Editor-Key': editorKey } }),
    [editorKey],
  );

  useEffect(() => {
    const stored = readPublications()[project.id];
    if (!stored || new Date(stored.expiresAt).getTime() <= Date.now()) {
      setPublication(null);
      return;
    }
    setPublication(stored);
  }, [project.id]);

  const previewUrl = useMemo(
    () => publication ? new URL(publication.path, window.location.origin).toString() : '',
    [publication],
  );

  const persistPublication = (next: PreviewPublication | null) => {
    const stored = readPublications();
    if (next) stored[project.id] = next;
    else delete stored[project.id];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    setPublication(next);
  };

  const handlePublish = async () => {
    setAction('publish');
    setError('');
    const saved = await onBeforePublish();
    if (!saved) {
      setError('Save failed or conflict unresolved. Fix the save error before publishing a preview.');
      setAction(null);
      return;
    }
    try {
      const next = await publishPreview({
        projectId: project.id,
        projectUpdatedAt: project.updatedAt,
        site,
      }, requestOptions);
      persistPublication(next);
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setAction(null);
    }
  };

  const handleRefresh = async () => {
    if (!publication) return;
    setAction('refresh');
    setError('');
    setCopied(false);
    const saved = await onBeforePublish();
    if (!saved) {
      setError('Save failed or conflict unresolved. Fix the save error before refreshing the preview.');
      setAction(null);
      return;
    }
    try {
      const next = await refreshPreview(publication.previewId, {
        projectUpdatedAt: project.updatedAt,
        site,
      }, requestOptions);
      persistPublication(next);
    } catch (cause) {
      const message = getErrorMessage(cause);
      if (message.toLowerCase().includes('not found')) persistPublication(null);
      setError(message);
    } finally {
      setAction(null);
    }
  };

  const handleRevoke = async () => {
    if (!publication) return;
    setAction('revoke');
    setError('');
    try {
      await revokePreview(publication.previewId, requestOptions);
      persistPublication(null);
    } catch (cause) {
      const message = getErrorMessage(cause);
      if (message.toLowerCase().includes('not found')) persistPublication(null);
      else setError(message);
    } finally {
      setAction(null);
    }
  };

  const handleCopy = async () => {
    if (!previewUrl) return;
    try {
      await navigator.clipboard.writeText(previewUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copy failed. Select the link and copy it manually.');
    }
  };

  const isWorking = action !== null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2" data-testid="btn-share-preview">
          <Link2 size={16} />
          <span className="hidden sm:inline">Share preview</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Client preview</DialogTitle>
          <DialogDescription>
            Publish a private, unlisted link for client review. Links expire after 24 hours.
          </DialogDescription>
        </DialogHeader>

        {publication ? (
          <div className="space-y-4 pt-2">
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-2 text-sm font-medium text-emerald-700">
                <Check size={16} />
                Preview is live
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Expires {new Date(publication.expiresAt).toLocaleString()}
              </p>
            </div>

            <div className="flex gap-2">
              <Input
                aria-label="Client preview link"
                value={previewUrl}
                readOnly
                onFocus={(event) => event.currentTarget.select()}
                data-testid="input-preview-link"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={handleCopy}
                aria-label="Copy preview link"
                data-testid="btn-copy-preview"
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
              </Button>
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                aria-label="Open preview"
              >
                <ExternalLink size={16} />
              </a>
            </div>

            <p className="text-xs text-muted-foreground">
              Refresh republishes the latest saved project and replaces the previous link.
            </p>

            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                onClick={handleRefresh}
                disabled={isWorking}
                data-testid="btn-refresh-preview"
              >
                {action === 'refresh' ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                Refresh link
              </Button>
              <Button
                type="button"
                variant="destructive"
                className="gap-2"
                onClick={handleRevoke}
                disabled={isWorking}
                data-testid="btn-revoke-preview"
              >
                {action === 'revoke' ? <Loader2 size={16} className="animate-spin" /> : <ShieldOff size={16} />}
                Revoke
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 pt-2">
            <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
              Anyone with the unguessable link can view every generated page. The preview is not indexed by search engines.
            </div>
            <Button
              type="button"
              className="w-full gap-2"
              onClick={handlePublish}
              disabled={isWorking}
              data-testid="btn-publish-preview"
            >
              {action === 'publish' ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />}
              Publish client preview
            </Button>
          </div>
        )}

        {error && (
          <p className="text-sm text-destructive" role="alert" data-testid="preview-error">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
