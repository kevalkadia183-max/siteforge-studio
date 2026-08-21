import React, { useState } from 'react';
import { Link } from 'wouter';
import {
  Mail, MessageSquare, Loader2, ArrowLeft, Filter, 
  Search, CheckCircle, XCircle, Clock, ExternalLink, RefreshCw, AlertTriangle, Play, FileText, X
} from 'lucide-react';
import {
  useListOutreachDrafts,
  getListOutreachDraftsQueryKey,
  useGetLeadOutreach,
  getGetLeadOutreachQueryKey,
  ListOutreachDraftsParams
} from '@workspace/api-client-react';
import { Button, Input, Select } from '@/components/ui/forms';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from '@/components/ui/table';
import { format } from 'date-fns';
import { DraftCard } from '@/components/leads/lead-outreach';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

export default function LeadsOutreach() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [channelFilter, setChannelFilter] = useState('all');
  const [pageOffset, setPageOffset] = useState(0);
  const limit = 20;
  
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPageOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const params: ListOutreachDraftsParams = { 
    search: debouncedSearch || undefined, 
    status: statusFilter === 'all' ? undefined : statusFilter as any,
    channel: channelFilter === 'all' ? undefined : channelFilter as any,
    offset: pageOffset,
    limit: limit
  };

  const { data: listData, isLoading, error, refetch } = useListOutreachDrafts(params, {
    query: {
      queryKey: getListOutreachDraftsQueryKey(params)
    }
  });

  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);

  return (
    <div className="h-dvh flex flex-col bg-background text-foreground overflow-hidden">
      <header className="min-h-14 border-b border-border bg-card flex flex-col sm:flex-row sm:items-center px-4 py-3 sm:py-0 shrink-0 z-10 justify-between gap-3 sm:gap-0">
        <div className="flex items-center gap-2 sm:gap-4 w-full sm:w-auto">
          <Link href="/leads" className="p-1.5 hover:bg-muted rounded-md text-muted-foreground transition-colors shrink-0" title="Back to Leads">
            <ArrowLeft size={18} />
          </Link>
          <div className="flex items-center gap-2 font-semibold min-w-0">
            <Mail size={18} className="text-primary shrink-0" />
            <span className="truncate text-base sm:text-sm">Central Outreach Workspace</span>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar bg-secondary/20">
        <div className="max-w-7xl mx-auto space-y-6">
          <div className="flex flex-col md:flex-row gap-4 justify-between items-start md:items-end mb-6">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">Outreach Review</h1>
              <p className="text-muted-foreground mt-1">Review, track, and explicitly manage your fact-grounded communication.</p>
            </div>
          </div>

          <div className="border border-border rounded-xl bg-card shadow-sm flex flex-col overflow-hidden">
            <div className="p-4 border-b border-border flex flex-col sm:flex-row gap-3 justify-between items-center bg-muted/10">
              <div className="relative w-full sm:max-w-xs">
                <Search className="absolute left-2.5 top-2.5 text-muted-foreground" size={14} />
                <Input 
                  placeholder="Search business or recipient..." 
                  className="pl-8 h-9 text-sm bg-background" 
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 w-full sm:w-auto">
                <Filter size={16} className="text-muted-foreground shrink-0 hidden md:block" />
                <Select 
                  className="h-9 w-full sm:w-36 text-sm bg-background"
                  value={channelFilter}
                  onChange={e => { setChannelFilter(e.target.value); setPageOffset(0); }}
                  aria-label="Channel"
                >
                  <option value="all">Channel (All)</option>
                  <option value="email">Email</option>
                  <option value="whatsapp">WhatsApp</option>
                </Select>
                <Select 
                  className="h-9 w-full sm:w-40 text-sm bg-background"
                  value={statusFilter}
                  onChange={e => { setStatusFilter(e.target.value); setPageOffset(0); }}
                  aria-label="Status"
                >
                  <option value="all">Status (All)</option>
                  <option value="draft">Unreviewed Draft</option>
                  <option value="reviewed">Reviewed (Ready)</option>
                  <option value="gmail_draft_created">Prepared in Gmail</option>
                  <option value="replied">Replied (Manual)</option>
                  <option value="discarded">Discarded</option>
                </Select>
              </div>
            </div>
            
            <div className="relative overflow-x-auto min-h-[400px]">
              {error ? (
                <div className="flex flex-col items-center justify-center p-12 text-destructive">
                  <AlertTriangle size={32} className="mb-4" />
                  <p>Failed to load outreach drafts.</p>
                  <Button onClick={() => refetch()} variant="outline" className="mt-4">Retry</Button>
                </div>
              ) : isLoading ? (
                <div className="absolute inset-0 flex items-center justify-center text-muted-foreground bg-background/50 backdrop-blur-sm z-10">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 size={24} className="animate-spin text-primary" />
                    <span>Loading drafts...</span>
                  </div>
                </div>
              ) : listData?.drafts && listData.drafts.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/20 hover:bg-muted/20 border-b border-border">
                      <TableHead className="w-[300px]">Recipient & Business</TableHead>
                      <TableHead>Channel & Status</TableHead>
                      <TableHead className="hidden md:table-cell">Subject / Preview</TableHead>
                      <TableHead className="w-[150px]">Last Updated</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {listData.drafts.map((draft) => (
                      <TableRow key={draft.id} className="group relative hover:bg-muted/10 cursor-pointer transition-colors" onClick={() => setSelectedLeadId(draft.leadId)}>
                        <TableCell>
                          <div className="font-semibold text-foreground group-hover:text-primary transition-colors">
                            {draft.leadBusinessName || 'Unknown Business'}
                          </div>
                          <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1.5">
                            {draft.channel === 'email' ? <Mail size={12} /> : <MessageSquare size={12} />}
                            <span className="truncate max-w-[200px]">{draft.recipientDisplay || 'No recipient configured'}</span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1.5 relative z-10">
                            <div className="flex items-center gap-2">
                              <ChannelBadge channel={draft.channel} />
                            </div>
                            <DraftStatusBadge status={draft.status} reviewed={draft.reviewed} gmailState={draft.gmailState} channel={draft.channel} />
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell relative z-10">
                          {draft.channel === 'email' && draft.subject ? (
                            <div className="text-sm font-medium mb-1 truncate max-w-[250px] lg:max-w-[400px]">
                              {draft.subject}
                            </div>
                          ) : null}
                          <div className="text-xs text-muted-foreground line-clamp-1 max-w-[250px] lg:max-w-[400px]">
                            {draft.body}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {format(new Date(draft.updatedAt), 'MMM d, h:mm a')}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="flex flex-col items-center justify-center h-64 text-muted-foreground">
                  <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
                    <FileText size={20} className="opacity-50" />
                  </div>
                  <h3 className="text-lg font-medium text-foreground mb-1">No drafts found</h3>
                  <p className="text-sm">Adjust your filters or prepare a new draft from a lead profile.</p>
                </div>
              )}
            </div>
            
            {listData && listData.total > 0 && (
              <div className="p-3 border-t border-border bg-muted/10 flex items-center justify-between text-sm">
                <span className="text-muted-foreground font-medium">
                  Showing {listData.offset + 1} - {Math.min(listData.offset + listData.limit, listData.total)} of {listData.total}
                </span>
                <div className="flex gap-2">
                  <Button 
                    variant="outline" 
                    size="sm" 
                    disabled={listData.offset === 0}
                    onClick={() => setPageOffset(Math.max(0, listData.offset - listData.limit))}
                  >
                    Previous
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    disabled={listData.offset + listData.limit >= listData.total}
                    onClick={() => setPageOffset(listData.offset + listData.limit)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <OutreachDetailPanel leadId={selectedLeadId} onClose={() => setSelectedLeadId(null)} />
    </div>
  );
}

function OutreachDetailPanel({ leadId, onClose }: { leadId: string | null, onClose: () => void }) {
  const { data: outreachSummary, isLoading, error } = useGetLeadOutreach(leadId || '', {
    query: {
      enabled: !!leadId,
      queryKey: getGetLeadOutreachQueryKey(leadId || '')
    }
  });

  return (
    <Sheet open={!!leadId} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-xl md:max-w-2xl overflow-y-auto custom-scrollbar p-0">
        <SheetHeader className="p-6 border-b border-border bg-card sticky top-0 z-10 flex flex-col items-start gap-4">
          <SheetTitle className="text-xl">Outreach Details</SheetTitle>
          {leadId && (
            <Link href={`/leads/${leadId}`} className="text-sm text-primary hover:underline flex items-center gap-1">
              View Lead Record <ExternalLink size={12} />
            </Link>
          )}
        </SheetHeader>
        <div className="p-6">
          {isLoading ? (
            <div className="flex justify-center p-8"><Loader2 className="animate-spin text-primary" /></div>
          ) : error ? (
            <div className="text-center text-destructive p-4">Failed to load outreach details.</div>
          ) : outreachSummary ? (
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
              ) : null}

              {outreachSummary.drafts.length > 0 ? (
                <div className="space-y-4">
                  <h3 className="font-medium text-lg border-b border-border pb-2">Active Drafts</h3>
                  {outreachSummary.drafts.map((draft) => (
                    <DraftCard key={draft.id} draft={draft} leadId={leadId!} isBlocked={outreachSummary.suppressed || outreachSummary.optedOut} />
                  ))}
                </div>
              ) : (
                <div className="text-muted-foreground text-sm italic">No active drafts.</div>
              )}
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function ChannelBadge({ channel }: { channel: string }) {
  if (channel === 'email') {
    return <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider text-blue-600 bg-blue-50 dark:text-blue-400 dark:bg-blue-900/30 px-2 py-0.5 rounded border border-blue-200 dark:border-blue-900/50"><Mail size={10} /> Email</span>;
  }
  return <span className="inline-flex items-center gap-1 text-[10px] uppercase font-bold tracking-wider text-emerald-600 bg-emerald-50 dark:text-emerald-400 dark:bg-emerald-900/30 px-2 py-0.5 rounded border border-emerald-200 dark:border-emerald-900/50"><MessageSquare size={10} /> WhatsApp</span>;
}

export function DraftStatusBadge({ status, reviewed, gmailState, channel }: { status: string, reviewed: boolean, gmailState: string, channel: string }) {
  if (status === 'discarded') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-500"><X size={12} /> Discarded</span>;
  }
  if (status === 'replied') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-purple-600 dark:text-purple-400"><CheckCircle size={12} /> Manual Reply Logged</span>;
  }
  if (status === 'gmail_draft_created' || gmailState === 'created') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 dark:text-blue-400"><ExternalLink size={12} /> Prepared in Gmail</span>;
  }
  if (gmailState === 'requesting') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600"><Loader2 size={12} className="animate-spin" /> Gmail draft confirmation pending</span>;
  }
  if (gmailState === 'failed') {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive"><AlertTriangle size={12} /> Gmail draft could not be created</span>;
  }
  if (reviewed) {
    return <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400"><CheckCircle size={12} /> Reviewed & Ready</span>;
  }
  return <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 dark:text-amber-500"><AlertTriangle size={12} /> Needs Review</span>;
}
