import React, { useState } from 'react';
import { Link } from 'wouter';
import {
  Users, Loader2, ArrowLeft, Filter, 
  Search, ShieldAlert, BadgeInfo, CheckCircle, 
  XCircle, Clock, ExternalLink, RefreshCw, BarChart2, Mail
} from 'lucide-react';
import {
  useGetLeadAcquisitionConfig,
  useGetLeadAcquisitionDashboard,
  useListLeads,
  getListLeadsQueryKey,
  getGetLeadAcquisitionDashboardQueryKey,
  type ListLeadsParams
} from '@workspace/api-client-react';
import { Button, Input, Select } from '@/components/ui/forms';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow
} from '@/components/ui/table';
import { format } from 'date-fns';
import { LeadCreateDialog } from '@/components/leads/lead-create-dialog';
import { LeadImportDialog } from '@/components/leads/lead-import-dialog';

export default function Leads() {
  const { data: config, isLoading: configLoading, error: configError, refetch: refetchConfig } = useGetLeadAcquisitionConfig();
  const { data: dashboard, isLoading: dashLoading, error: dashError, refetch: refetchDash } = useGetLeadAcquisitionDashboard({
    query: { enabled: !!config?.enabled, queryKey: getGetLeadAcquisitionDashboardQueryKey() }
  });
  
  const [search, setSearch] = useState('');
  const [pipelineFilter, setPipelineFilter] = useState('all');
  const [websiteFilter, setWebsiteFilter] = useState('all');
  const [suppressedFilter, setSuppressedFilter] = useState('false');
  const [pageOffset, setPageOffset] = useState(0);
  const limit = 20;
  
  // Use debounced search for the API
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  React.useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPageOffset(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Reset offset when filters change
  const handlePipelineFilterChange = (val: string) => { setPipelineFilter(val); setPageOffset(0); };
  const handleWebsiteFilterChange = (val: string) => { setWebsiteFilter(val); setPageOffset(0); };
  const handleSuppressedFilterChange = (val: string) => { setSuppressedFilter(val); setPageOffset(0); };

  const params: ListLeadsParams = { 
    search: debouncedSearch || undefined, 
    pipelineStatus: pipelineFilter === 'all' ? undefined : (pipelineFilter as any),
    websiteStatus: websiteFilter === 'all' ? undefined : (websiteFilter as any),
    suppressed: suppressedFilter === 'all' ? undefined : (suppressedFilter as any),
    offset: pageOffset,
    limit: limit
  };
  const { data: leadsData, isLoading: leadsLoading, error: leadsError, refetch: refetchLeads } = useListLeads(params, {
    query: {
      enabled: !!config?.enabled,
      queryKey: getListLeadsQueryKey(params)
    }
  });

  if (configLoading) {
    return (
      <div className="h-dvh flex items-center justify-center bg-background">
        <Loader2 className="animate-spin text-primary" size={32} />
      </div>
    );
  }

  if (configError) {
    return (
      <div className="h-dvh flex flex-col items-center justify-center bg-background text-destructive space-y-4">
        <ShieldAlert size={32} />
        <p>Failed to load workspace configuration.</p>
        <Button onClick={() => refetchConfig()} variant="outline">Retry</Button>
      </div>
    );
  }

  if (!config?.enabled) {
    return (
      <div className="h-dvh flex flex-col items-center justify-center bg-background text-muted-foreground p-6">
        <Users size={48} className="opacity-20 mb-4" />
        <h2 className="text-xl font-medium text-foreground mb-2">Lead Acquisition Disabled</h2>
        <p className="mb-6 max-w-md text-center">
          The Lead Acquisition workspace is currently disabled for this project. 
          Enable it in the project settings to start gathering and scoring leads.
        </p>
        <Link href="/" className="btn btn-solid">Back to Editor</Link>
      </div>
    );
  }

  return (
    <div className="h-dvh flex flex-col bg-background text-foreground overflow-hidden">
      <header className="min-h-14 border-b border-border bg-card flex flex-col sm:flex-row sm:items-center px-4 py-3 sm:py-0 shrink-0 z-10 justify-between gap-3 sm:gap-0">
        <div className="flex items-center gap-2 sm:gap-4 w-full sm:w-auto">
          <Link href="/" className="p-1.5 hover:bg-muted rounded-md text-muted-foreground transition-colors shrink-0" title="Back to Editor">
            <ArrowLeft size={18} />
          </Link>
          <div className="flex items-center gap-2 font-semibold min-w-0">
            <Users size={18} className="text-primary shrink-0" />
            <span className="truncate text-base sm:text-sm">Lead Acquisition Workspace</span>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 sm:gap-3 w-full sm:w-auto">
          {config?.discoveryProvider && !config.discoveryProvider.configured && (
            <div className="hidden sm:flex items-center gap-2 text-xs bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-900 px-3 py-1.5 rounded-full shrink-0">
              <ShieldAlert size={14} />
              Provider not configured.
            </div>
          )}
          <Link href="/leads/outreach" className="btn btn-outline h-9 px-3 gap-2 flex text-sm items-center">
            <Mail size={16} /> Outreach
          </Link>
          <LeadImportDialog />
          <LeadCreateDialog />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar">
        <div className="max-w-7xl mx-auto space-y-6">
          
          {dashError ? (
            <div className="p-4 rounded-xl border border-destructive/20 bg-destructive/10 text-destructive flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldAlert size={16} />
                <span className="text-sm font-medium">Failed to load dashboard metrics.</span>
              </div>
              <Button onClick={() => refetchDash()} variant="outline" size="sm" className="h-8">Retry</Button>
            </div>
          ) : dashboard ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard title="Total Leads" value={dashboard.totalLeads} icon={<Users size={20} />} />
              <MetricCard 
                title="Avg Score" 
                value={dashboard.averageScore ? dashboard.averageScore.toFixed(1) : '-'} 
                icon={<BarChart2 size={20} />} 
              />
              <MetricCard 
                title="Suppressed" 
                value={dashboard.suppressedLeads} 
                icon={<ShieldAlert size={20} />} 
                valueClass="text-amber-600 dark:text-amber-400"
              />
              <MetricCard 
                title="New Leads" 
                value={dashboard.pipelineCounts.new || 0} 
                icon={<BadgeInfo size={20} />} 
                valueClass="text-blue-600 dark:text-blue-400"
              />
            </div>
          ) : null}

          <div className="border border-border rounded-lg bg-card shadow-sm flex flex-col">
            <div className="p-4 border-b border-border flex flex-col sm:flex-row gap-3 justify-between items-center">
              <div className="relative w-full sm:max-w-xs">
                <Search className="absolute left-2.5 top-2.5 text-muted-foreground" size={14} />
                <Input 
                  placeholder="Search business name..." 
                  className="pl-8 h-9 text-sm" 
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>
              <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 w-full sm:w-auto">
                <Filter size={16} className="text-muted-foreground shrink-0 hidden md:block" />
                <Select 
                  className="h-9 w-full sm:w-36 text-sm"
                  value={pipelineFilter}
                  onChange={e => handlePipelineFilterChange(e.target.value)}
                  aria-label="Pipeline Status"
                >
                  <option value="all">Pipeline (All)</option>
                  <option value="new">New</option>
                  <option value="contacted">Contacted</option>
                  <option value="qualified">Qualified</option>
                  <option value="proposal">Proposal</option>
                  <option value="won">Won</option>
                  <option value="lost">Lost</option>
                  <option value="archived">Archived</option>
                </Select>
                <Select 
                  className="h-9 w-full sm:w-36 text-sm"
                  value={websiteFilter}
                  onChange={e => handleWebsiteFilterChange(e.target.value)}
                  aria-label="Website Status"
                >
                  <option value="all">Website (All)</option>
                  <option value="unknown">Unverified</option>
                  <option value="has_website">Has Website</option>
                  <option value="no_website">No Website</option>
                  <option value="placeholder">Placeholder</option>
                  <option value="outdated">Outdated</option>
                </Select>
                <Select 
                  className="h-9 w-full sm:w-36 text-sm"
                  value={suppressedFilter}
                  onChange={e => handleSuppressedFilterChange(e.target.value)}
                  aria-label="Contactable Status"
                >
                  <option value="all">All Leads</option>
                  <option value="false">Contactable</option>
                  <option value="true">Do Not Contact</option>
                </Select>
              </div>
            </div>
            
            <div className="relative overflow-x-auto min-h-[300px]">
              {leadsError ? (
                <div className="flex flex-col items-center justify-center p-12 text-destructive">
                  <ShieldAlert size={32} className="mb-4" />
                  <p>Failed to load leads.</p>
                  <Button onClick={() => refetchLeads()} variant="outline" className="mt-4">Retry</Button>
                </div>
              ) : leadsLoading || dashLoading ? (
                <div className="absolute inset-0 flex items-center justify-center text-muted-foreground bg-muted/5 z-10">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 size={24} className="animate-spin text-primary" />
                    <span>Loading...</span>
                  </div>
                </div>
              ) : leadsData?.leads && leadsData.leads.length > 0 ? (
                <>
                  <div className="hidden md:block">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/30 hover:bg-muted/30">
                          <TableHead>Business</TableHead>
                          <TableHead>Pipeline</TableHead>
                          <TableHead>Score</TableHead>
                          <TableHead>Website</TableHead>
                          <TableHead>Created</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {leadsData.leads.map((lead) => (
                          <TableRow key={lead.id} className="group relative">
                            <TableCell>
                              <Link href={`/leads/${lead.id}`} className="absolute inset-0 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent">
                                <span className="sr-only">View {lead.businessName}</span>
                              </Link>
                              <div className="font-medium text-foreground group-hover:text-primary transition-colors">
                                {lead.businessName}
                              </div>
                              <div className="text-xs text-muted-foreground mt-1 line-clamp-1">
                                {lead.city ? `${lead.city}, ${lead.region || ''}` : lead.email || 'No location data'}
                              </div>
                            </TableCell>
                            <TableCell>
                              <PipelineBadge status={lead.pipelineStatus} />
                            </TableCell>
                            <TableCell>
                              <ScoreBadge score={lead.scoreSummary?.score} band={lead.scoreSummary?.band} />
                            </TableCell>
                            <TableCell>
                              <WebsiteBadge status={lead.websiteStatus} url={lead.websiteUrl} />
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                              {format(new Date(lead.createdAt), 'MMM d, yyyy')}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <div className="md:hidden flex flex-col divide-y divide-border">
                    {leadsData.leads.map((lead) => (
                      <div key={lead.id} className="relative p-4 group hover:bg-muted/30 transition-colors">
                        <Link href={`/leads/${lead.id}`} className="absolute inset-0 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent">
                          <span className="sr-only">View {lead.businessName}</span>
                        </Link>
                        <div className="flex flex-col gap-3">
                          <div className="flex justify-between items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="font-medium text-foreground group-hover:text-primary transition-colors truncate">
                                {lead.businessName}
                              </div>
                              <div className="text-xs text-muted-foreground mt-0.5 truncate">
                                {lead.city ? `${lead.city}, ${lead.region || ''}` : lead.email || 'No location data'}
                              </div>
                            </div>
                            <div className="shrink-0 relative z-10">
                              <ScoreBadge score={lead.scoreSummary?.score} band={lead.scoreSummary?.band} />
                            </div>
                          </div>
                          
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="relative z-10">
                              <PipelineBadge status={lead.pipelineStatus} />
                            </div>
                            {lead.suppressionSummary?.suppressed && (
                              <span className="relative z-10 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400 border-rose-200 dark:border-rose-800">
                                DNC
                              </span>
                            )}
                            <WebsiteBadge status={lead.websiteStatus} url={lead.websiteUrl} />
                          </div>
                          
                          <div className="text-[11px] text-muted-foreground">
                            Added {format(new Date(lead.createdAt), 'MMM d, yyyy')}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center p-12 text-muted-foreground">
                  <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
                    <Users size={20} className="opacity-50" />
                  </div>
                  <h3 className="text-lg font-medium text-foreground mb-1">No leads found</h3>
                  <p className="text-sm">Try adjusting your search or filters, or add a new lead.</p>
                </div>
              )}
            </div>
            
            {leadsData && leadsData.total > 0 && (
              <div className="p-3 border-t border-border bg-muted/10 flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  Showing {leadsData.offset + 1} - {Math.min(leadsData.offset + leadsData.limit, leadsData.total)} of {leadsData.total}
                </span>
                <div className="flex gap-2">
                  <Button 
                    variant="outline" 
                    size="sm" 
                    disabled={leadsData.offset === 0}
                    onClick={() => setPageOffset(Math.max(0, leadsData.offset - leadsData.limit))}
                  >
                    Previous
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    disabled={leadsData.offset + leadsData.limit >= leadsData.total}
                    onClick={() => setPageOffset(leadsData.offset + leadsData.limit)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
          
        </div>
      </div>
    </div>
  );
}

function MetricCard({ title, value, icon, valueClass = "" }: { title: string, value: string | number, icon: React.ReactNode, valueClass?: string }) {
  return (
    <div className="p-4 rounded-xl border border-border bg-card shadow-sm">
      <div className="flex justify-between items-center mb-2">
        <span className="text-sm font-medium text-muted-foreground">{title}</span>
        <div className="text-muted-foreground/50">{icon}</div>
      </div>
      <div className={`text-2xl font-bold ${valueClass}`}>{value}</div>
    </div>
  );
}

export function PipelineBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    new: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 border-blue-200 dark:border-blue-800",
    contacted: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 border-purple-200 dark:border-purple-800",
    qualified: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800",
    proposal: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800",
    won: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800",
    lost: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400 border-rose-200 dark:border-rose-800",
    archived: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700",
  };
  
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border capitalize ${styles[status] || styles.new}`}>
      {status}
    </span>
  );
}

export function ScoreBadge({ score, band }: { score?: number | null, band?: string | null }) {
  if (score === undefined || score === null) {
    return <span className="text-muted-foreground text-xs font-medium">Unscored</span>;
  }
  
  const isHigh = band === 'high' || score >= 80;
  const isMedium = band === 'medium' || (score >= 50 && score < 80);
  
  const colorClass = isHigh 
    ? "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20" 
    : isMedium 
      ? "text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20"
      : "text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-900/20";
      
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-bold ${colorClass}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current"></span>
      {score}
    </span>
  );
}

export function WebsiteBadge({ status, url }: { status: string, url?: string | null }) {
  const ui = {
    unknown: { icon: <RefreshCw size={12} />, label: "Unverified", color: "text-slate-500" },
    has_website: { icon: <CheckCircle size={12} />, label: "Has Website", color: "text-emerald-600" },
    no_website: { icon: <XCircle size={12} />, label: "No Website", color: "text-rose-600" },
    placeholder: { icon: <Clock size={12} />, label: "Placeholder", color: "text-amber-600" },
    outdated: { icon: <BadgeInfo size={12} />, label: "Outdated", color: "text-amber-600" },
  }[status] || { icon: <BadgeInfo size={12} />, label: status, color: "text-muted-foreground" };
  
  return (
    <div className="flex flex-col gap-1 items-start relative z-10">
      <div className={`flex items-center gap-1 text-xs font-medium ${ui.color}`}>
        {ui.icon} {ui.label}
      </div>
      {url && (
        <a 
          href={url.startsWith('http') ? url : `https://${url}`} 
          target="_blank" 
          rel="noreferrer"
          className="text-[10px] text-muted-foreground hover:text-primary transition-colors flex items-center gap-1 truncate max-w-[150px]"
        >
          {url.replace(/^https?:\/\//, '')} <ExternalLink size={10} />
        </a>
      )}
    </div>
  );
}
