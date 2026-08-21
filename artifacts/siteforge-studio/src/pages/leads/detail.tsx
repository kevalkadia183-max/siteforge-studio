import React, { useState } from 'react';
import { Link } from 'wouter';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Users, Loader2, ArrowLeft, ShieldAlert, BadgeInfo,
  ExternalLink, RefreshCw, Save, X, Activity, Link as LinkIcon, Edit,
  ShieldCheck
} from 'lucide-react';
import {
  useGetLead,
  useUpdateLead,
  useScoreLeadNow,
  useSuppressLead,
  useUnsuppressLead,
  getGetLeadQueryKey,
  getListLeadsQueryKey,
  getGetLeadAcquisitionDashboardQueryKey
} from '@workspace/api-client-react';
import { Button, Input, Select, Textarea, Label } from '@/components/ui/forms';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { format } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { PipelineBadge, ScoreBadge, WebsiteBadge } from '@/pages/leads/index';
import { ProspectSiteCard } from '@/components/leads/prospect-site-card';
import { LeadOutreach } from '@/components/leads/lead-outreach';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export default function LeadDetail({ leadId }: { leadId: string }) {
  const { data: detail, isLoading, error: leadError, refetch } = useGetLead(leadId, {
    query: { queryKey: getGetLeadQueryKey(leadId) }
  });

  const [isEditing, setIsEditing] = useState(false);

  if (isLoading) {
    return (
      <div className="h-dvh flex items-center justify-center bg-background">
        <Loader2 className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  if (leadError) {
    return (
      <div className="h-dvh flex flex-col items-center justify-center bg-background text-destructive space-y-4">
        <ShieldAlert size={32} />
        <p>Failed to load lead details.</p>
        <Button onClick={() => refetch()} variant="outline">Retry</Button>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="h-dvh flex flex-col items-center justify-center bg-background text-muted-foreground p-6">
        <Users size={48} className="opacity-20 mb-4" />
        <h2 className="text-xl font-medium text-foreground mb-2">Lead Not Found</h2>
        <p className="mb-6">The lead you're looking for doesn't exist or has been removed.</p>
        <Link href="/leads" className="btn btn-solid">Back to Leads</Link>
      </div>
    );
  }

  const { lead, sources, activities } = detail;

  return (
    <div className="h-dvh flex flex-col bg-background text-foreground overflow-hidden">
      <header className="h-14 border-b border-border bg-card flex items-center px-4 shrink-0 z-10 justify-between">
        <div className="flex items-center gap-4">
          <Link href="/leads" className="p-1.5 hover:bg-muted rounded-md text-muted-foreground transition-colors" title="Back to Leads">
            <ArrowLeft size={18} />
          </Link>
          <div className="flex items-center gap-3">
            <span className="font-semibold">{lead.businessName}</span>
            <PipelineBadge status={lead.pipelineStatus} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isEditing && (
            <Button variant="outline" size="sm" onClick={() => setIsEditing(true)} className="gap-2 h-8 text-xs">
              <Edit size={14} /> Edit
            </Button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar">
        <div className="max-w-5xl mx-auto">
          {(lead.sourceProvider || lead.sourceReference || lead.sourceState) && (
            <div className="mb-4 bg-muted/20 border border-border rounded-lg p-3 text-sm flex items-center justify-between">
              <div className="flex items-center gap-2">
                <BadgeInfo size={16} className="text-muted-foreground" />
                <span className="text-muted-foreground">Provider Details:</span>
                {lead.sourceProvider && (
                  <span className="font-medium">{lead.sourceProvider}</span>
                )}
                {lead.sourceState && (
                  <span className="ml-2 px-2 py-0.5 rounded-full bg-muted text-[10px] uppercase font-bold text-muted-foreground">
                    {lead.sourceState}
                  </span>
                )}
              </div>
              {lead.sourceReference && (
                <div className="text-muted-foreground text-xs font-mono">
                  Ref: {lead.sourceReference}
                </div>
              )}
            </div>
          )}

          {lead.suppressionSummary.suppressed && (
            <div className="mb-6 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-900 rounded-lg p-4 text-rose-800 dark:text-rose-300 flex items-start gap-3">
              <ShieldAlert className="shrink-0 mt-0.5" size={20} />
              <div className="flex-1">
                <h3 className="font-bold mb-1">
                  {lead.suppressionSummary.reason?.startsWith('Outreach opt-out')
                    ? 'Permanently Opted Out'
                    : 'Do Not Contact (Suppressed)'}
                </h3>
                <p className="text-sm">{lead.suppressionSummary.reason || "Suppressed by system or user."}</p>
                {lead.suppressionSummary.suppressedAt && (
                  <p className="text-xs mt-2 opacity-70">
                    Suppressed on {format(new Date(lead.suppressionSummary.suppressedAt), 'PP p')}
                  </p>
                )}
              </div>
              <UnsuppressButton leadId={lead.id} isPermanent={lead.suppressionSummary.reason?.startsWith('Outreach opt-out')} />
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-6">
              {isEditing ? (
                <EditLeadForm lead={lead} onCancel={() => setIsEditing(false)} onSaved={() => setIsEditing(false)} />
              ) : (
                <Tabs defaultValue="details" className="w-full">
                  <TabsList className="grid w-full grid-cols-2 mb-6">
                    <TabsTrigger value="details">Lead Details</TabsTrigger>
                    <TabsTrigger value="outreach">Outreach</TabsTrigger>
                  </TabsList>

                  <TabsContent value="details" className="space-y-6 m-0">
                    <div className="border border-border rounded-xl bg-card shadow-sm overflow-hidden">
                    <div className="p-4 border-b border-border bg-muted/20 font-medium">Business Details</div>
                    <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-y-6 gap-x-8">
                      <DetailItem label="Business Name" value={lead.businessName} />
                      <DetailItem label="Category" value={lead.category} />
                      <DetailItem label="Email" value={lead.email} />
                      <DetailItem label="Phone" value={lead.phone} />
                      <DetailItem label="Website" value={
                        <WebsiteBadge status={lead.websiteStatus} url={lead.websiteUrl} />
                      } />
                      <DetailItem label="Listing URL" value={
                        lead.listingUrl ? (
                          <a href={lead.listingUrl.startsWith('http') ? lead.listingUrl : `https://${lead.listingUrl}`} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                            Link <ExternalLink size={12} />
                          </a>
                        ) : null
                      } />
                      <DetailItem label="Address" value={[lead.address, lead.city, lead.region, lead.postalCode, lead.country].filter(Boolean).join(', ')} />
                      <DetailItem label="Rating / Reviews" value={
                        (lead.rating !== undefined && lead.rating !== null) ? `${lead.rating} (${lead.reviewCount || 0} reviews)` : null
                      } />
                      <div className="sm:col-span-2">
                        <DetailItem label="Services" value={lead.services} />
                      </div>
                      <div className="sm:col-span-2">
                        <DetailItem label="Description/Notes" value={lead.description} />
                      </div>
                    </div>
                  </div>

                  {sources.length > 0 && (
                    <div className="border border-border rounded-xl bg-card shadow-sm overflow-hidden">
                      <div className="p-4 border-b border-border bg-muted/20 font-medium flex items-center gap-2">
                        <LinkIcon size={16} className="text-muted-foreground" />
                        Data Provenance
                      </div>
                      <div className="p-0">
                        <table className="w-full text-sm text-left">
                          <thead className="bg-muted/10 border-b border-border text-xs text-muted-foreground uppercase">
                            <tr>
                              <th className="px-4 py-2 font-medium">Field</th>
                              <th className="px-4 py-2 font-medium">Value</th>
                              <th className="px-4 py-2 font-medium">Source</th>
                              <th className="px-4 py-2 font-medium">Date</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {sources.map(s => (
                              <tr key={s.id} className="hover:bg-muted/5">
                                <td className="px-4 py-2 font-medium">{s.fieldName}</td>
                                <td className="px-4 py-2 text-muted-foreground truncate max-w-[200px]" title={s.value || ''}>{s.value || '-'}</td>
                                <td className="px-4 py-2">
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-secondary text-secondary-foreground uppercase">
                                    {s.provenance}
                                  </span>
                                  {s.provider && <span className="ml-1 text-xs text-muted-foreground">({s.provider})</span>}
                                </td>
                                <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">
                                  {format(new Date(s.recordedAt), 'MMM d, yyyy')}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {activities.length > 0 && (
                    <div className="border border-border rounded-xl bg-card shadow-sm overflow-hidden">
                      <div className="p-4 border-b border-border bg-muted/20 font-medium flex items-center gap-2">
                        <Activity size={16} className="text-muted-foreground" />
                        Activity History
                      </div>
                      <div className="p-4 space-y-4">
                        {activities.map((act, i) => (
                          <div key={act.id} className="relative pl-6 pb-4 last:pb-0">
                            {i !== activities.length - 1 && (
                              <div className="absolute left-2 top-2 bottom-0 w-px bg-border"></div>
                            )}
                            <div className="absolute left-[3px] top-1 w-2.5 h-2.5 rounded-full bg-primary ring-4 ring-card"></div>
                            <div className="text-sm">
                              <span className="font-medium capitalize">{act.activityType.replace(/_/g, ' ')}</span>
                              <span className="text-muted-foreground ml-2 text-xs">
                                {format(new Date(act.occurredAt), 'MMM d, h:mm a')}
                              </span>
                            </div>
                            {act.note && <div className="text-sm text-muted-foreground mt-1 bg-muted/20 p-2 rounded">{act.note}</div>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  </TabsContent>

                  <TabsContent value="outreach" className="m-0">
                    <LeadOutreach leadId={leadId} lead={lead} sources={sources} />
                  </TabsContent>
                </Tabs>
              )}
            </div>

            <div className="space-y-6">
              <div className="border border-border rounded-xl bg-card shadow-sm overflow-hidden">
                <div className="p-4 border-b border-border bg-muted/20 font-medium flex items-center justify-between">
                  <span>Opportunity Score</span>
                  <ScoreLeadButton leadId={lead.id} />
                </div>
                <div className="p-5 flex flex-col items-center">
                  <div className="mb-4">
                    <ScoreBadge score={lead.scoreSummary.score} band={lead.scoreSummary.band} />
                  </div>

                  {lead.scoreSummary.reasons.length > 0 ? (
                    <div className="w-full space-y-2 mt-2">
                      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Score Factors</h4>
                      {lead.scoreSummary.reasons.map((r, i) => (
                        <div key={i} className="flex justify-between items-center text-sm border-b border-border/50 pb-2 last:border-0 last:pb-0">
                          <span>{r.label}</span>
                          <span className={r.points >= 0 ? "text-emerald-600 font-medium" : "text-rose-600 font-medium"}>
                            {r.points > 0 ? '+' : ''}{r.points}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground text-center py-4">
                      No score reasons available.
                    </div>
                  )}
                </div>
              </div>

              {!lead.suppressionSummary.suppressed && (
                <div className="border border-rose-200 dark:border-rose-900 rounded-xl bg-rose-50/50 dark:bg-rose-900/10 shadow-sm overflow-hidden">
                  <div className="p-4 border-b border-rose-200 dark:border-rose-900 font-medium text-rose-800 dark:text-rose-400">
                    Suppression Controls
                  </div>
                  <div className="p-4">
                    <p className="text-sm text-rose-700/80 dark:text-rose-400/80 mb-4">
                      Mark this lead as Do Not Contact if they have opted out or are a bad fit. AI discovery will ignore them.
                    </p>
                    <SuppressForm leadId={lead.id} />
                  </div>
                </div>
              )}

              <ProspectSiteCard lead={lead} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailItem({ label, value }: { label: string, value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1 font-medium">{label}</div>
      <div className="text-sm">{value || <span className="text-muted-foreground/50 italic">None</span>}</div>
    </div>
  );
}

function ScoreLeadButton({ leadId }: { leadId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const scoreLead = useScoreLeadNow();

  const handleScore = async () => {
    try {
      await scoreLead.mutateAsync({ leadId });
      queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
      queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLeadAcquisitionDashboardQueryKey() });
      toast({ title: 'Lead Scored', description: 'Opportunity score updated successfully.' });
    } catch (err: any) {
      toast({ title: 'Scoring Failed', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 text-[10px] gap-1 px-2"
      onClick={handleScore}
      disabled={scoreLead.isPending}
    >
      {scoreLead.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
      Refresh
    </Button>
  );
}

function UnsuppressButton({ leadId, isPermanent }: { leadId: string, isPermanent?: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const unsuppress = useUnsuppressLead();

  if (isPermanent) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="border-rose-300 text-rose-700 bg-rose-100 dark:border-rose-700 dark:text-rose-300 dark:bg-rose-900/50 cursor-not-allowed opacity-70"
        disabled
      >
        <ShieldAlert size={14} className="mr-2" />
        Permanent
      </Button>
    );
  }

  const handleUnsuppress = async () => {
    try {
      await unsuppress.mutateAsync({ leadId });
      queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
      queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLeadAcquisitionDashboardQueryKey() });
      toast({ title: 'Lead Unsuppressed', description: 'Lead can now be contacted again.' });
    } catch (err: any) {
      toast({ title: 'Action Failed', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      className="border-rose-300 text-rose-700 hover:bg-rose-100 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-900/50"
      onClick={handleUnsuppress}
      disabled={unsuppress.isPending}
    >
      {unsuppress.isPending ? <Loader2 size={14} className="animate-spin mr-2" /> : <ShieldCheck size={14} className="mr-2" />}
      Allow Contact
    </Button>
  );
}

function SuppressForm({ leadId }: { leadId: string }) {
  const [reason, setReason] = useState('');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const suppress = useSuppressLead();

  const handleSuppress = async () => {
    if (!reason.trim()) {
      toast({ title: 'Reason required', variant: 'destructive' });
      return;
    }
    try {
      await suppress.mutateAsync({ leadId, data: { reason } });
      setReason('');
      queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(leadId) });
      queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLeadAcquisitionDashboardQueryKey() });
      toast({ title: 'Lead Suppressed', description: 'Lead marked as Do Not Contact.' });
    } catch (err: any) {
      toast({ title: 'Action Failed', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-3">
      <Input
        placeholder="Reason for suppression..."
        value={reason}
        onChange={e => setReason(e.target.value)}
        className="bg-white dark:bg-black/20"
      />
      <Button
        variant="destructive"
        size="sm"
        className="w-full"
        onClick={handleSuppress}
        disabled={suppress.isPending || !reason.trim()}
      >
        {suppress.isPending ? <Loader2 size={14} className="animate-spin mr-2" /> : <ShieldAlert size={14} className="mr-2" />}
        Mark as Do Not Contact
      </Button>
    </div>
  );
}

const updateLeadSchema = z.object({
  businessName: z.string().min(1, 'Business name is required').max(300),
  email: z.string().email('Invalid email address').optional().or(z.literal('')),
  phone: z.string().max(50).optional().or(z.literal('')),
  websiteUrl: z.string().url('Invalid URL').optional().or(z.literal('')),
  listingUrl: z.string().url('Invalid URL').optional().or(z.literal('')),
  category: z.string().max(128).optional().or(z.literal('')),
  city: z.string().max(128).optional().or(z.literal('')),
  region: z.string().max(128).optional().or(z.literal('')),
  country: z.string().max(64).optional().or(z.literal('')),
  postalCode: z.string().max(20).optional().or(z.literal('')),
  address: z.string().max(500).optional().or(z.literal('')),
  description: z.string().max(2000).optional().or(z.literal('')),
  services: z.string().max(1000).optional().or(z.literal('')),
  rating: z.union([z.literal(''), z.coerce.number().min(0).max(5).optional()]),
  reviewCount: z.union([z.literal(''), z.coerce.number().min(0).optional()]),
  pipelineStatus: z.enum(['new', 'contacted', 'qualified', 'proposal', 'won', 'lost', 'archived']),
  websiteStatus: z.enum(['unknown', 'has_website', 'no_website', 'placeholder', 'outdated']),
});

type UpdateLeadForm = z.infer<typeof updateLeadSchema>;

function EditLeadForm({ lead, onCancel, onSaved }: { lead: any, onCancel: () => void, onSaved: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateLead = useUpdateLead();

  const form = useForm<UpdateLeadForm>({
    resolver: zodResolver(updateLeadSchema),
    defaultValues: {
      businessName: lead.businessName || '',
      email: lead.email || '',
      phone: lead.phone || '',
      websiteUrl: lead.websiteUrl || '',
      listingUrl: lead.listingUrl || '',
      category: lead.category || '',
      city: lead.city || '',
      region: lead.region || '',
      country: lead.country || '',
      postalCode: lead.postalCode || '',
      address: lead.address || '',
      description: lead.description || '',
      services: lead.services || '',
      rating: lead.rating ?? '',
      reviewCount: lead.reviewCount ?? '',
      pipelineStatus: lead.pipelineStatus,
      websiteStatus: lead.websiteStatus,
    },
  });

  const onSubmit = async (data: UpdateLeadForm) => {
    try {
      const patchData: Record<string, any> = {};
      let hasChanges = false;

      Object.entries(data).forEach(([k, v]) => {
        let formValue = v as any;
        if (k !== 'businessName' && k !== 'pipelineStatus' && k !== 'websiteStatus') {
          if (v === '' || v === undefined || (typeof v === 'number' && isNaN(v))) {
            formValue = null;
          }
        }

        let originalValue = lead[k];
        if (originalValue === undefined) originalValue = null;

        if (k === 'rating' || k === 'reviewCount') {
          if (formValue !== null) formValue = Number(formValue);
          if (originalValue !== null) originalValue = Number(originalValue);
        }

        if (formValue !== originalValue) {
          patchData[k] = formValue;
          hasChanges = true;
        }
      });

      if (!hasChanges) {
        onSaved();
        return;
      }

      await updateLead.mutateAsync({
        leadId: lead.id,
        data: patchData,
      });

      toast({ title: 'Lead Updated', description: 'Changes saved successfully.' });

      queryClient.invalidateQueries({ queryKey: getGetLeadQueryKey(lead.id) });
      queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLeadAcquisitionDashboardQueryKey() });

      onSaved();
    } catch (err: any) {
      toast({ title: 'Update Failed', description: err.message, variant: 'destructive' });
    }
  };

  return (
    <div className="border border-primary/20 rounded-xl bg-card shadow-md overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/10 font-medium flex items-center justify-between">
        <div className="flex items-center gap-2 text-primary">
          <Edit size={16} /> Edit Lead
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onCancel}><X size={14} /></Button>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="p-5 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField control={form.control} name="businessName" render={({ field }) => (
              <FormItem><FormLabel>Business Name *</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="category" render={({ field }) => (
              <FormItem><FormLabel>Category</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="email" render={({ field }) => (
              <FormItem><FormLabel>Email</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="phone" render={({ field }) => (
              <FormItem><FormLabel>Phone</FormLabel><FormControl><Input type="tel" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="websiteUrl" render={({ field }) => (
              <FormItem><FormLabel>Website URL</FormLabel><FormControl><Input type="url" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="listingUrl" render={({ field }) => (
              <FormItem><FormLabel>Listing URL</FormLabel><FormControl><Input type="url" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="websiteStatus" render={({ field }) => (
              <FormItem><FormLabel>Website Status</FormLabel>
                <Select {...field}>
                  <option value="unknown">Unverified (Verify first)</option>
                  <option value="has_website">Has Website</option>
                  <option value="no_website">No Website</option>
                  <option value="placeholder">Placeholder</option>
                  <option value="outdated">Outdated</option>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="address" render={({ field }) => (
              <FormItem className="sm:col-span-2"><FormLabel>Address</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="city" render={({ field }) => (
              <FormItem><FormLabel>City</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="region" render={({ field }) => (
              <FormItem><FormLabel>Region / State</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="postalCode" render={({ field }) => (
              <FormItem><FormLabel>Postal Code</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="country" render={({ field }) => (
              <FormItem><FormLabel>Country</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="rating" render={({ field }) => (
              <FormItem><FormLabel>Rating (0-5)</FormLabel><FormControl><Input type="number" step="0.1" min="0" max="5" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="reviewCount" render={({ field }) => (
              <FormItem><FormLabel>Review Count</FormLabel><FormControl><Input type="number" min="0" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="services" render={({ field }) => (
              <FormItem className="sm:col-span-2"><FormLabel>Services (comma separated)</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="pipelineStatus" render={({ field }) => (
              <FormItem className="sm:col-span-2"><FormLabel>Pipeline Status</FormLabel>
                <Select {...field}>
                  <option value="new">New</option>
                  <option value="contacted">Contacted</option>
                  <option value="qualified">Qualified</option>
                  <option value="proposal">Proposal</option>
                  <option value="won">Won</option>
                  <option value="lost">Lost</option>
                  <option value="archived">Archived</option>
                </Select>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="description" render={({ field }) => (
              <FormItem className="sm:col-span-2"><FormLabel>Description / Notes</FormLabel><FormControl><Textarea {...field} /></FormControl><FormMessage /></FormItem>
            )} />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-border">
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={updateLead.isPending}>
              {updateLead.isPending && <Loader2 size={14} className="animate-spin mr-2" />}
              <Save size={14} className="mr-2" /> Save Changes
            </Button>
          </div>
        </form>
      </Form>
    </div>
  );
}
