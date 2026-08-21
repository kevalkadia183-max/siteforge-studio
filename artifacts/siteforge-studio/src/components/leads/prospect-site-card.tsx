import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import {
  useGetProspectSite,
  useGenerateProspectSite,
  useRegenerateProspectSite,
  usePublishProspectPreview,
  useRevokeProspectPreview,
  useArchiveProspectSite,
  useConvertProspectSite,
  getGetProspectSiteQueryKey,
  getGetLeadQueryKey,
  getListLeadsQueryKey,
  getGetLeadAcquisitionDashboardQueryKey,
  getListWebsitesQueryKey,
  LeadRecord,
  ProspectSiteRecord,
} from '@workspace/api-client-react';
import { Button, Input, Select, Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/forms';
import { Checkbox } from '@/components/ui/checkbox';
import { format } from 'date-fns';
import { Loader2, ExternalLink, RefreshCw, Trash2, ArrowRightCircle, Sparkles, AlertTriangle, Link as LinkIcon, Edit, Lock, EyeOff } from 'lucide-react';
import { Link } from 'wouter';

export function ProspectSiteCard({ lead }: { lead: LeadRecord }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: prospectSite, isLoading } = useGetProspectSite(lead.id, {
    query: { queryKey: getGetProspectSiteQueryKey(lead.id) }
  });

  if (isLoading) {
    return (
      <div className="border border-border rounded-xl bg-card p-6 flex justify-center text-muted-foreground">
        <Loader2 className="animate-spin" size={24} />
      </div>
    );
  }

  const isQualified = lead.pipelineStatus === 'qualified';
  const isSuppressed = lead.suppressionSummary?.suppressed;

  if (!prospectSite) {
    if (isSuppressed) {
      return (
        <EmptyState message="This lead is suppressed. Unsuppress to generate a prospect site." />
      );
    }
    if (!isQualified) {
      return (
        <EmptyState message="Lead must be in 'Qualified' status to generate a prospect site." />
      );
    }
    return (
      <div className="border border-border rounded-xl bg-card shadow-sm overflow-hidden p-6 text-center space-y-4">
        <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto text-primary">
          <Sparkles size={24} />
        </div>
        <div>
          <h3 className="text-lg font-medium">Prospect Draft</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Generate an impressive initial site design to win this lead.
          </p>
        </div>
        <GenerateDialog lead={lead} isRegenerate={false} />
      </div>
    );
  }

  return (
    <div className="border border-border rounded-xl bg-card shadow-sm overflow-hidden flex flex-col">
      <div className="p-4 border-b border-border bg-muted/20 font-medium flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-primary" />
          Prospect Draft
          <StateBadge state={prospectSite.state} />
        </div>
      </div>
      
      <div className="p-5 space-y-6">
        <div className="grid grid-cols-2 gap-4 text-sm">
          {prospectSite.websiteId && (
            <div>
              <div className="text-muted-foreground text-xs font-medium">Project ID</div>
              <div className="font-mono mt-1">{prospectSite.websiteId}</div>
            </div>
          )}
          <div>
            <div className="text-muted-foreground text-xs font-medium">Generated</div>
            <div className="mt-1">{format(new Date(prospectSite.createdAt), 'PP')}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs font-medium">Generation Count</div>
            <div className="mt-1">{prospectSite.generationCount}</div>
          </div>
          {prospectSite.templateId && (
            <div>
              <div className="text-muted-foreground text-xs font-medium">Template</div>
              <div className="mt-1 capitalize">{prospectSite.templateId.replace('-', ' ')}</div>
            </div>
          )}
        </div>

        {prospectSite.state === 'active_draft' && (
          <ActiveDraftActions lead={lead} site={prospectSite} />
        )}

        {prospectSite.state === 'archived' && (
          <div className="space-y-4">
            <div className="p-3 bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-200 text-sm rounded-md flex gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <div>This draft is archived. Regenerate to create a new draft.</div>
            </div>
            <GenerateDialog lead={lead} isRegenerate={true} />
          </div>
        )}

        {prospectSite.state === 'converted' && (
          <div className="space-y-4">
            <div className="p-3 bg-emerald-50 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-200 text-sm rounded-md flex gap-2">
              <ArrowRightCircle size={16} className="shrink-0 mt-0.5" />
              <div>This draft was converted into a customer site.</div>
            </div>
            <Link href={`/studio?project=${prospectSite.websiteId}`} className="btn btn-outline w-full justify-center gap-2">
              <Edit size={16} /> Open Customer Site in Studio
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="border border-border border-dashed rounded-xl bg-muted/5 p-6 flex flex-col items-center justify-center text-center text-muted-foreground space-y-2">
      <Lock size={24} className="opacity-50" />
      <p className="text-sm">{message}</p>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const map: Record<string, { label: string, classes: string }> = {
    active_draft: { label: 'Active Draft', classes: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
    archived: { label: 'Archived', classes: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300' },
    converted: { label: 'Converted', classes: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300' },
  };
  const conf = map[state] || { label: state, classes: 'bg-muted text-muted-foreground' };
  return (
    <span className={`px-2 py-0.5 text-[10px] uppercase font-bold tracking-wider rounded-full ${conf.classes}`}>
      {conf.label}
    </span>
  );
}

const TEMPLATES = ['home-services', 'advisor', 'cafe', 'wellness', 'creative', 'plumber', 'electrician', 'carpenter'];

function GenerateDialog({ lead, isRegenerate }: { lead: LeadRecord, isRegenerate: boolean }) {
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState('auto');
  const [verified, setVerified] = useState<Record<string, boolean>>({ businessName: true });
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const generate = useGenerateProspectSite();
  const regenerate = useRegenerateProspectSite();
  
  const isPending = generate.isPending || regenerate.isPending;

  const fields = [
    { key: 'category', label: 'Category' },
    { key: 'description', label: 'Description' },
    { key: 'city', label: 'City' },
    { key: 'region', label: 'Region' },
    { key: 'address', label: 'Address' },
    { key: 'postalCode', label: 'Postal Code' },
    { key: 'country', label: 'Country' },
    { key: 'phone', label: 'Phone' },
    { key: 'email', label: 'Email' },
    { key: 'services', label: 'Services' },
  ] as const;

  const handleToggle = (key: string, checked: boolean) => {
    setVerified(prev => ({ ...prev, [key]: checked }));
  };

  const onSubmit = async () => {
    try {
      const data: any = {
        verifiedFields: { ...verified, businessName: true }
      };
      if (template !== 'auto') {
        data.templateId = template;
      }

      if (isRegenerate) {
        await regenerate.mutateAsync({ leadId: lead.id, data });
        toast({ title: 'Draft Regenerated' });
      } else {
        await generate.mutateAsync({ leadId: lead.id, data });
        toast({ title: 'Draft Generated' });
      }
      
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: getGetProspectSiteQueryKey(lead.id) });
      queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(lead.id) });
      queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLeadAcquisitionDashboardQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListWebsitesQueryKey() });
      
    } catch (err: any) {
      toast({ title: 'Generation Failed', description: err.message || 'An error occurred', variant: 'destructive' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={isRegenerate ? 'outline' : 'default'} className="w-full gap-2">
          {isRegenerate ? <RefreshCw size={16} /> : <Sparkles size={16} />}
          {isRegenerate ? 'Regenerate Draft' : 'Generate Prospect Site'}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isRegenerate ? 'Regenerate Draft' : 'Generate Draft'}</DialogTitle>
        </DialogHeader>
        
        <div className="space-y-4 pt-4">
          {isRegenerate && (
            <div className="p-3 bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-200 text-sm rounded-md flex gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <div>The old site will be archived and a new project ID will be generated.</div>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Select Template (Optional)</label>
            <Select value={template} onChange={e => setTemplate(e.target.value)}>
              <option value="auto">Automatic (Best fit)</option>
              {TEMPLATES.map(t => (
                <option key={t} value={t}>{t.replace('-', ' ')}</option>
              ))}
            </Select>
          </div>

          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">Verify Lead Information</label>
              <p className="text-xs text-muted-foreground">Select the fields you have reviewed. These exact values will be used to generate the site content.</p>
            </div>
            
            <div className="space-y-2 border border-border rounded-md p-3 max-h-[300px] overflow-y-auto">
              <label className="flex items-start gap-3 cursor-not-allowed opacity-80">
                <Checkbox checked disabled className="mt-1" />
                <div className="grid gap-0.5">
                  <span className="text-sm font-medium leading-none">Business Name</span>
                  <span className="text-xs text-muted-foreground">{lead.businessName}</span>
                </div>
              </label>

              {fields.map(({ key, label }) => {
                const val = (lead as any)[key];
                if (!val) return null;
                return (
                  <label key={key} className="flex items-start gap-3 cursor-pointer p-1 hover:bg-muted/50 rounded">
                    <Checkbox 
                      checked={!!verified[key]} 
                      onCheckedChange={(c) => handleToggle(key, !!c)}
                      className="mt-1"
                    />
                    <div className="grid gap-0.5">
                      <span className="text-sm font-medium leading-none">{label}</span>
                      <span className="text-xs text-muted-foreground max-w-[400px] truncate">{val}</span>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
          
          <Button onClick={onSubmit} disabled={isPending} className="w-full mt-2">
            {isPending && <Loader2 size={16} className="animate-spin mr-2" />}
            {isRegenerate ? 'Confirm Regenerate' : 'Generate Now'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ActiveDraftActions({ lead, site }: { lead: LeadRecord, site: ProspectSiteRecord }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isCopied, setIsCopied] = useState(false);
  
  const publish = usePublishProspectPreview();
  const revoke = useRevokeProspectPreview();
  const archive = useArchiveProspectSite();
  const convert = useConvertProspectSite();

  const handleAction = async (action: 'publish' | 'revoke' | 'archive' | 'convert') => {
    try {
      if (action === 'archive') {
        if (!confirm('Are you sure you want to archive this draft?')) return;
        await archive.mutateAsync({ leadId: lead.id });
        toast({ title: 'Draft Archived' });
      } else if (action === 'convert') {
        if (!confirm('Convert this draft into a regular customer site? The site will be preserved with a new revision.')) return;
        await convert.mutateAsync({ leadId: lead.id, data: { expectedRevision: site.websiteRevision || 0 } });
        toast({ title: 'Converted to Customer Site' });
      } else if (action === 'publish') {
        await publish.mutateAsync({ leadId: lead.id, data: { expectedRevision: site.websiteRevision || 0 } });
        toast({ title: 'Preview Published' });
      } else if (action === 'revoke') {
        if (!confirm('Revoke the active preview link?')) return;
        await revoke.mutateAsync({ leadId: lead.id });
        toast({ title: 'Preview Revoked' });
      }
      
      queryClient.invalidateQueries({ queryKey: getGetProspectSiteQueryKey(lead.id) });
      queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(lead.id) });
      queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLeadAcquisitionDashboardQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListWebsitesQueryKey() });
    } catch (err: any) {
      toast({ title: 'Action Failed', description: err.message, variant: 'destructive' });
    }
  };

  const copyLink = async () => {
    if (!site.previewPath) return;
    const url = new URL(site.previewPath, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      setIsCopied(true);
      toast({ title: 'Link Copied' });
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      toast({ title: 'Failed to copy', variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-4">
      <Link href={`/studio?project=${site.websiteId}`} className="btn btn-default w-full justify-center gap-2">
        <Edit size={16} /> Edit in Studio
      </Link>
      
      <div className="border border-border rounded-lg p-4 bg-muted/10 space-y-3">
        <h4 className="text-sm font-medium flex items-center gap-2">
          <EyeOff size={16} className={site.hasActivePreview ? 'text-primary' : 'text-muted-foreground'} />
          Preview Link
        </h4>
        
        {site.hasActivePreview && site.previewPath ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input readOnly value={new URL(site.previewPath, window.location.origin).toString()} className="font-mono text-xs" />
              <Button variant="outline" size="icon" onClick={copyLink} className="shrink-0">
                <LinkIcon size={14} className={isCopied ? 'text-green-500' : ''} />
              </Button>
              <a href={new URL(site.previewPath, window.location.origin).toString()} target="_blank" rel="noreferrer">
                <Button variant="outline" size="icon" className="shrink-0">
                  <ExternalLink size={14} />
                </Button>
              </a>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => handleAction('publish')} disabled={publish.isPending} className="flex-1">
                <RefreshCw size={14} className={`mr-2 ${publish.isPending ? 'animate-spin' : ''}`} /> Update Link
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleAction('revoke')} disabled={revoke.isPending} className="text-destructive hover:bg-destructive/10">
                Revoke
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="w-full gap-2" onClick={() => handleAction('publish')} disabled={publish.isPending}>
            {publish.isPending && <Loader2 size={14} className="animate-spin" />}
            Publish Preview
          </Button>
        )}
      </div>

      <div className="flex gap-2 pt-2">
        <GenerateDialog lead={lead} isRegenerate={true} />
      </div>
      
      <div className="flex gap-2 border-t border-border pt-4">
        <Button variant="outline" size="sm" onClick={() => handleAction('archive')} disabled={archive.isPending} className="flex-1 text-muted-foreground">
          <Trash2 size={14} className="mr-2" /> Archive
        </Button>
        <Button variant="outline" size="sm" onClick={() => handleAction('convert')} disabled={convert.isPending} className="flex-1 border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-900/20">
          <ArrowRightCircle size={14} className="mr-2" /> Convert to Customer
        </Button>
      </div>
    </div>
  );
}
