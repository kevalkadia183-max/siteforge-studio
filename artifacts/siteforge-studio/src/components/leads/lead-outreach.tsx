import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Loader2, Mail, MessageSquare, ExternalLink,
  RefreshCw, CheckCircle, AlertTriangle, X, Trash2
} from 'lucide-react';
import {
  useGetLeadOutreach,
  useCreateOutreachDraft,
  useUpdateOutreachDraft,
  useReviewOutreachDraft,
  useCreateOutreachGmailDraft,
  useDiscardOutreachDraft,
  useMarkOutreachReply,
  useOptOutLeadOutreach,
  getGetLeadOutreachQueryKey,
  getListOutreachDraftsQueryKey,
  getListLeadsQueryKey,
  getGetLeadQueryKey,
  getGetLeadAcquisitionDashboardQueryKey
} from '@workspace/api-client-react';
import { Button, Input, Select, Textarea, Label } from '@/components/ui/forms';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { DraftStatusBadge } from '@/pages/leads/outreach/index';

const createDraftSchema = z.object({
  channel: z.enum(['email', 'whatsapp']),
  selectedFields: z.array(z.string()).min(1, 'Select at least one field to ground the draft.'),
  confirmImportedFields: z.array(z.string()).optional(),
});

type CreateDraftForm = z.infer<typeof createDraftSchema>;

export function LeadOutreach({ leadId, lead, sources }: { leadId: string, lead: any, sources: any[] }) {
  const { data: outreachSummary, isLoading, error, refetch } = useGetLeadOutreach(leadId, {
    query: { queryKey: getGetLeadOutreachQueryKey(leadId) }
  });

  if (isLoading) {
    return <div className="p-8 flex justify-center"><Loader2 className="animate-spin text-primary" /></div>;
  }

  if (error) {
    return (
      <div className="p-6 text-center text-destructive border border-destructive/20 rounded-xl bg-destructive/5">
        <AlertTriangle className="mx-auto mb-2" />
        <p>Failed to load outreach history.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-4">Retry</Button>
      </div>
    );
  }

  if (!outreachSummary) return null;

  return (
    <div className="space-y-6">
      {outreachSummary.suppressed || outreachSummary.optedOut ? (
        <div className="bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-900 rounded-lg p-4 text-rose-800 dark:text-rose-300">
          <div className="flex items-start gap-3">
            <AlertTriangle className="shrink-0 mt-0.5" size={20} />
            <div>
              <h3 className="font-bold mb-1">Outreach Blocked</h3>
              <p className="text-sm">
                {outreachSummary.blockedReason || 'This lead cannot be contacted due to suppression or opt-out.'}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <CreateDraftCard leadId={leadId} lead={lead} sources={sources} />
      )}

      {outreachSummary.drafts.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-medium text-lg border-b border-border pb-2">Drafts & Active Outreach</h3>
          {outreachSummary.drafts.map(draft => (
            <DraftCard key={draft.id} draft={draft} leadId={leadId} isBlocked={outreachSummary.suppressed || outreachSummary.optedOut} />
          ))}
        </div>
      )}
      
      {!outreachSummary.suppressed && !outreachSummary.optedOut && (
        <div className="space-y-4 pt-4 border-t border-border">
          <OptOutForm leadId={leadId} />
        </div>
      )}

      {outreachSummary.history.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-medium text-lg border-b border-border pb-2">Outreach History</h3>
          <div className="space-y-4">
            {outreachSummary.history.map(evt => (
              <div key={evt.id} className="relative pl-6 pb-4 last:pb-0 text-sm">
                <div className="absolute left-[3px] top-1 w-2.5 h-2.5 rounded-full bg-muted-foreground ring-4 ring-card"></div>
                <div className="absolute left-2 top-2 bottom-0 w-px bg-border last:hidden"></div>
                <div className="font-medium text-foreground">{evt.eventType.replace(/_/g, ' ')}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {new Date(evt.occurredAt).toLocaleString()}
                </div>
                {evt.performedBy && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    By: {evt.performedBy}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CreateDraftCard({ leadId, lead, sources }: { leadId: string, lead: any, sources: any[] }) {
  const [isCreating, setIsCreating] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createDraft = useCreateOutreachDraft();

  const form = useForm<CreateDraftForm>({
    resolver: zodResolver(createDraftSchema),
    defaultValues: {
      channel: 'email',
      selectedFields: ['businessName'],
      confirmImportedFields: [],
    }
  });

  const availableFields = [
    { key: 'businessName', label: 'Business Name', val: lead.businessName },
    { key: 'category', label: 'Category', val: lead.category },
    { key: 'city', label: 'City', val: lead.city },
    { key: 'region', label: 'Region', val: lead.region },
    { key: 'websiteUrl', label: 'Website URL', val: lead.websiteUrl },
    { key: 'services', label: 'Services', val: lead.services },
    { key: 'description', label: 'Description/Notes', val: lead.description },
  ].filter(f => !!f.val);

  const watchSelected = form.watch('selectedFields') || [];
  const watchConfirm = form.watch('confirmImportedFields') || [];

  const getBestSource = (key: string) => {
    const fieldSources = sources.filter(s => s.fieldName === key);
    if (!fieldSources.length) return null;
    const verified = fieldSources.find(s => s.provenance === 'verified');
    if (verified) return verified;
    const userProvided = fieldSources.find(s => s.provenance === 'user_provided');
    if (userProvided) return userProvided;
    return fieldSources[0];
  };

  const onSubmit = async (data: CreateDraftForm) => {
    const finalSelectedFields = Array.from(new Set([...data.selectedFields, 'businessName']));

    const unconfirmedFields = finalSelectedFields.filter(key => {
      const src = getBestSource(key);
      const needsConfirm = !src || (src.provenance !== 'user_provided' && src.provenance !== 'verified');
      return needsConfirm && !watchConfirm.includes(key);
    });
    
    if (unconfirmedFields.length > 0) {
      toast({ title: 'Confirmation required', description: 'Please confirm imported fields before generating a draft.', variant: 'destructive' });
      return;
    }

    const actualData = {
      ...data,
      selectedFields: finalSelectedFields,
      confirmImportedFields: data.confirmImportedFields?.filter(k => finalSelectedFields.includes(k)) || []
    };

    try {
      await createDraft.mutateAsync({ leadId, data: actualData as any });
      toast({ title: 'Draft created', description: 'Outreach draft successfully generated.' });
      queryClient.invalidateQueries({ queryKey: getGetLeadOutreachQueryKey(leadId) });
      queryClient.invalidateQueries({ queryKey: getListOutreachDraftsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
      setIsCreating(false);
      form.reset();
    } catch (err: any) {
      toast({ title: 'Failed to create draft', description: err.message, variant: 'destructive' });
    }
  };

  if (!isCreating) {
    return (
      <Button onClick={() => setIsCreating(true)} className="w-full gap-2 border-dashed border-2 py-8 bg-muted/5 hover:bg-muted/10 text-muted-foreground hover:text-foreground" variant="outline">
        <Mail size={16} /> Prepare Outreach Draft
      </Button>
    );
  }

  return (
    <div className="border border-border rounded-xl bg-card shadow-sm overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/20 font-medium flex items-center justify-between">
        <span>Prepare Outreach Draft</span>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setIsCreating(false)}>
          <X size={14} />
        </Button>
      </div>
      <div className="p-5">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField control={form.control} name="channel" render={({ field }) => (
              <FormItem>
                <FormLabel>Channel</FormLabel>
                <Select {...field}>
                  <option value="email">Email</option>
                  <option value="whatsapp">WhatsApp</option>
                </Select>
                <FormMessage />
              </FormItem>
            )} />

            <div className="space-y-3">
              <Label>Select fields to ground the draft message (the message will deterministically reference these)</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 border rounded-lg p-3 bg-muted/5">
                {availableFields.map(f => {
                  const src = getBestSource(f.key);
                  const needsConfirm = !src || (src.provenance !== 'user_provided' && src.provenance !== 'verified');
                  const isSelected = watchSelected.includes(f.key) || f.key === 'businessName';
                  const isConfirmed = watchConfirm.includes(f.key);
                  const displayProvenance = src ? src.provenance : 'unverified';

                  return (
                    <div key={f.key} className={`flex flex-col gap-1 p-2 border border-border/50 rounded bg-card text-sm ${f.key === 'businessName' ? 'ring-1 ring-primary/20' : ''}`}>
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={isSelected}
                          disabled={f.key === 'businessName'}
                          onChange={(e) => {
                            if (f.key === 'businessName') return;
                            const newSel = e.target.checked 
                              ? [...watchSelected, f.key] 
                              : watchSelected.filter(k => k !== f.key);
                            form.setValue('selectedFields', newSel);
                            if (!e.target.checked && needsConfirm) {
                              form.setValue('confirmImportedFields', watchConfirm.filter(k => k !== f.key));
                            }
                          }}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-xs flex items-center gap-1.5">
                            {f.label}
                            {f.key === 'businessName' && (
                              <span className="text-[9px] uppercase tracking-wider text-primary bg-primary/10 px-1 py-0.5 rounded">Required</span>
                            )}
                            {src ? (
                              <span className="text-[9px] uppercase tracking-wider text-muted-foreground bg-muted px-1 py-0.5 rounded ml-auto">
                                {src.provenance}
                              </span>
                            ) : (
                              <span className="text-[9px] uppercase tracking-wider text-amber-700 bg-amber-100 dark:text-amber-400 dark:bg-amber-900/30 px-1 py-0.5 rounded ml-auto">
                                unverified
                              </span>
                            )}
                          </div>
                          <div className="text-muted-foreground text-xs truncate mt-0.5" title={f.val}>{f.val}</div>
                        </div>
                      </div>
                      
                      {isSelected && needsConfirm && (
                        <div className="mt-1 ml-5 flex items-start gap-2 p-1.5 bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-900 rounded relative">
                          <input
                            type="checkbox"
                            data-testid={`confirm-${f.key}`}
                            className="mt-0.5 accent-amber-600 relative z-10 cursor-pointer"
                            checked={isConfirmed}
                            onChange={(e) => {
                              const newConf = e.target.checked 
                                ? [...watchConfirm, f.key] 
                                : watchConfirm.filter(k => k !== f.key);
                              form.setValue('confirmImportedFields', newConf);
                            }}
                          />
                          <div className="text-[10px] text-amber-800 dark:text-amber-400">
                            Confirm this fact ({displayProvenance}) is correct before including it.
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {form.formState.errors.selectedFields?.message ? (
                <p className="text-sm font-medium text-destructive">
                  {form.formState.errors.selectedFields.message}
                </p>
              ) : null}
            </div>

            <Button type="submit" disabled={createDraft.isPending} className="w-full">
              {createDraft.isPending && <Loader2 size={14} className="animate-spin mr-2" />}
              Create Fact-Grounded Draft
            </Button>
          </form>
        </Form>
      </div>
    </div>
  );
}

export function DraftCard({ draft, leadId, isBlocked }: { draft: any, leadId: string, isBlocked?: boolean }) {
  const [isEditing, setIsEditing] = useState(false);
  const [subject, setSubject] = useState(draft.subject || '');
  const [body, setBody] = useState(draft.body || '');
  
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const updateDraft = useUpdateOutreachDraft();
  const reviewDraft = useReviewOutreachDraft();
  const createGmail = useCreateOutreachGmailDraft();
  const discardDraft = useDiscardOutreachDraft();
  const markReply = useMarkOutreachReply();

  const handleUpdate = async () => {
    try {
      await updateDraft.mutateAsync({ leadId, draftId: draft.id, data: { subject, body } });
      toast({ title: 'Draft updated', description: 'Edits saved successfully.' });
      setIsEditing(false);
    } catch (err: any) {
      toast({ title: 'Update failed', description: err.message, variant: 'destructive' });
    } finally {
      queryClient.invalidateQueries({ queryKey: getGetLeadOutreachQueryKey(leadId) });
      queryClient.invalidateQueries({ queryKey: getListOutreachDraftsQueryKey() });
    }
  };

  const handleAction = async (actionFn: any, successMsg: string, desc: string) => {
    try {
      await actionFn.mutateAsync({ leadId, draftId: draft.id });
      toast({ title: successMsg, description: desc });
    } catch (err: any) {
      toast({ title: 'Action failed', description: err.message, variant: 'destructive' });
    } finally {
      queryClient.invalidateQueries({ queryKey: getGetLeadOutreachQueryKey(leadId) });
      queryClient.invalidateQueries({ queryKey: getListOutreachDraftsQueryKey() });
    }
  };

  const isDiscarded = draft.status === 'discarded';
  const isReplied = draft.status === 'replied';
  
  return (
    <div className={`border border-border rounded-xl bg-card shadow-sm overflow-hidden ${isDiscarded ? 'opacity-70' : ''}`}>
      <div className="p-3 border-b border-border bg-muted/20 flex flex-wrap gap-2 items-center justify-between">
        <div className="flex items-center gap-3">
          <DraftStatusBadge status={draft.status} reviewed={draft.reviewed} gmailState={draft.gmailState} channel={draft.channel} />
          <span className="text-xs text-muted-foreground">
            Created {new Date(draft.createdAt).toLocaleDateString()}
          </span>
        </div>
        
        {!isDiscarded && !isReplied && !isBlocked && (
          <div className="flex items-center gap-2">
            {draft.gmailState === 'none' && !isEditing && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setIsEditing(true)}>
                Edit
              </Button>
            )}
            
            {!draft.reviewed && draft.gmailState === 'none' && !isEditing && (
              <Button size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700" 
                onClick={() => handleAction(reviewDraft, 'Draft Reviewed', 'Draft marked as ready.')}
                disabled={reviewDraft.isPending}>
                {reviewDraft.isPending && <Loader2 size={12} className="animate-spin mr-1" />}
                Mark Reviewed
              </Button>
            )}

            {draft.reviewed && draft.channel === 'email' && draft.gmailState !== 'created' && draft.gmailState !== 'requesting' && (
              <Button size="sm" className="h-7 text-xs bg-blue-600 hover:bg-blue-700"
                onClick={async () => {
                  try {
                    await createGmail.mutateAsync({ leadId, draftId: draft.id });
                    toast({ title: 'Gmail Draft Created', description: 'Ready for your review in Gmail.' });
                  } catch (err: any) {
                    toast({ title: 'Gmail Action Failed', description: err.message, variant: 'destructive' });
                  } finally {
                    queryClient.invalidateQueries({ queryKey: getGetLeadOutreachQueryKey(leadId) });
                    queryClient.invalidateQueries({ queryKey: getListOutreachDraftsQueryKey() });
                  }
                }}
                disabled={createGmail.isPending}>
                {createGmail.isPending && <Loader2 size={12} className="animate-spin mr-1" />}
                {draft.gmailState === 'failed' ? 'Retry Gmail Prep' : 'Prepare in Gmail'}
              </Button>
            )}

            {draft.channel === 'email' && draft.gmailState === 'requesting' && (
              <Button size="sm" variant="outline" className="h-7 text-xs"
                onClick={async () => {
                  try {
                    await createGmail.mutateAsync({ leadId, draftId: draft.id });
                    toast({ title: 'Check Complete', description: 'Gmail draft state updated.' });
                  } catch (err: any) {
                    toast({ title: 'Check Failed', description: err.message, variant: 'destructive' });
                  } finally {
                    queryClient.invalidateQueries({ queryKey: getGetLeadOutreachQueryKey(leadId) });
                    queryClient.invalidateQueries({ queryKey: getListOutreachDraftsQueryKey() });
                  }
                }}
                disabled={createGmail.isPending}>
                {createGmail.isPending && <Loader2 size={12} className="animate-spin mr-1" />}
                Check Gmail draft status
              </Button>
            )}

            {draft.channel === 'whatsapp' && (
              <Button size="sm" className="h-7 text-xs bg-muted text-muted-foreground hover:bg-muted cursor-not-allowed" title="WhatsApp provider not configured" disabled>
                WhatsApp Not Configured
              </Button>
            )}

            {(draft.gmailState === 'created' || (draft.reviewed && draft.channel === 'whatsapp')) && (
              <Button size="sm" variant="outline" className="h-7 text-xs border-purple-200 text-purple-700 hover:bg-purple-50 dark:border-purple-900 dark:text-purple-400"
                onClick={() => handleAction(markReply, 'Reply Logged', 'Recorded owner-observed manual reply.')}
                disabled={markReply.isPending}>
                Mark Manual Reply
              </Button>
            )}

            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                if (confirm('Discard this draft?')) {
                  handleAction(discardDraft, 'Draft Discarded', 'Outreach attempt discarded.');
                }
              }}
              disabled={discardDraft.isPending}>
              <Trash2 size={14} />
            </Button>
          </div>
        )}
      </div>

      <div className="p-4">
        {isEditing ? (
          <div className="space-y-4">
            {draft.reviewed && (
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-900 rounded p-2 text-amber-800 dark:text-amber-400 text-xs">
                <strong>Note:</strong> Saving changes will clear the "Reviewed & Ready" status. You must review the draft again before it can be prepared in Gmail.
              </div>
            )}
            {draft.channel === 'email' && (
              <div className="space-y-1.5">
                <Label>Subject</Label>
                <Input value={subject} onChange={e => setSubject(e.target.value)} />
              </div>
            )}
            <div className="space-y-1.5">
              <Label>Message Body</Label>
              <Textarea value={body} onChange={e => setBody(e.target.value)} className="min-h-[150px]" />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={() => { setIsEditing(false); setSubject(draft.subject||''); setBody(draft.body||''); }}>Cancel</Button>
              <Button size="sm" onClick={handleUpdate} disabled={updateDraft.isPending}>
                {updateDraft.isPending && <Loader2 size={12} className="animate-spin mr-1" />}
                Save Edits
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            {draft.channel === 'email' && (
              <div className="flex border-b border-border pb-2">
                <span className="w-20 font-medium text-muted-foreground">Subject:</span>
                <span className="font-semibold">{draft.subject}</span>
              </div>
            )}
            <div className="whitespace-pre-wrap text-foreground">{draft.body}</div>
            
            {draft.failureReason && (
              <div className="mt-4 pt-3 border-t border-border flex items-start gap-2 text-amber-700 dark:text-amber-400 text-xs">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>{draft.failureReason}</span>
              </div>
            )}
            {draft.factSnapshot && draft.factSnapshot.length > 0 && (
              <div className="mt-4 pt-3 border-t border-border">
                <div className="text-xs font-semibold text-muted-foreground uppercase mb-2">Facts Selected for Generation</div>
                <div className="flex flex-wrap gap-2">
                  {draft.factSnapshot.map((fact: any, i: number) => (
                    <span key={i} className="inline-flex items-center px-2 py-0.5 rounded text-[10px] border border-border bg-muted/30">
                      <span className="font-medium mr-1">{fact.fieldName}:</span>
                      <span className="truncate max-w-[150px]">{fact.value}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function OptOutForm({ leadId }: { leadId: string }) {
  const [reason, setReason] = useState('');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const optOut = useOptOutLeadOutreach();

  const handleOptOut = async () => {
    if (!reason.trim()) {
      toast({ title: 'Reason required', variant: 'destructive' });
      return;
    }
    if (!confirm('Opt-out is permanent and cannot be reversed. Continue?')) {
      return;
    }
    
    try {
      await optOut.mutateAsync({ leadId, data: { reason } });
      toast({ title: 'Lead Opted Out', description: 'Outreach permanently blocked for this lead.' });
      queryClient.invalidateQueries({ queryKey: getGetLeadOutreachQueryKey(leadId) });
      queryClient.invalidateQueries({ queryKey: getListOutreachDraftsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
      queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLeadAcquisitionDashboardQueryKey() });
      setReason('');
    } catch (err: any) {
      toast({ title: 'Action failed', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <div className="border border-rose-200 dark:border-rose-900 rounded-xl bg-rose-50/50 dark:bg-rose-900/10 shadow-sm overflow-hidden">
      <div className="p-4 border-b border-rose-200 dark:border-rose-900 font-medium text-rose-800 dark:text-rose-400">
        Permanent Opt-Out
      </div>
      <div className="p-4">
        <p className="text-sm text-rose-700/80 dark:text-rose-400/80 mb-4">
          Permanently block all future outreach for this lead. This action cannot be undone.
        </p>
        <div className="space-y-3">
          <Input 
            placeholder="Reason for opt-out..." 
            value={reason} 
            onChange={e => setReason(e.target.value)} 
            className="bg-white dark:bg-black/20"
          />
          <Button 
            variant="destructive" 
            size="sm" 
            className="w-full"
            onClick={handleOptOut}
            disabled={optOut.isPending || !reason.trim()}
          >
            {optOut.isPending && <Loader2 size={14} className="animate-spin mr-2" />}
            Permanently Opt-Out
          </Button>
        </div>
      </div>
    </div>
  );
}
