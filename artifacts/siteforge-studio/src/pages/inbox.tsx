import { useState } from 'react';
import { useStudio } from '../hooks/use-studio';
import { Link } from 'wouter';
import { 
  Loader2, ArrowLeft, Mail, MessageSquare, PhoneCall, 
  CheckCircle, XCircle, Search, Mailbox, Activity
} from 'lucide-react';
import { 
  useListReceptionistConversations, 
  useGetConversation,
  useOwnerReply,
  useSyncGmail,
  useApproveEmailDraft,
  useRecoverEmailDraft,
  useRejectEmailDraft,
  useUpdateConversationStatus,
  useSyncRetellCalls,
  getGetConversationQueryKey,
  getListReceptionistConversationsQueryKey,
  type ChatMessage,
  type ConversationDetail,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Input, Textarea, Select } from '../components/ui/forms';
import { useToast } from '../hooks/use-toast';
import { cn } from '../lib/utils';
import { format } from 'date-fns';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed';
}

function formatEventType(eventType: string): string {
  return eventType
    .split('_')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export default function Inbox() {
  const { project, isReady } = useStudio();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [channelFilter, setChannelFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  
  if (!isReady) {
    return <div className="h-dvh flex items-center justify-center"><Loader2 className="animate-spin text-primary" /></div>;
  }

  if (!project || !project.receptionist?.receptionistId || !project.receptionist?.ownerKey) {
    return (
      <div className="h-dvh flex flex-col items-center justify-center p-6 text-center max-w-md mx-auto">
        <div className="w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-6">
          <MessageSquare size={32} className="text-muted-foreground" />
        </div>
        <h1 className="text-2xl font-bold mb-2">AI Receptionist Not Enabled</h1>
        <p className="text-muted-foreground mb-8">
          You need to enable the AI Receptionist in the SiteForge Studio editor before you can view the inbox.
        </p>
        <Link href="/" className="btn btn-solid w-full">Return to Editor</Link>
      </div>
    );
  }

  const { receptionistId, ownerKey } = project.receptionist;

  return (
    <div className="h-dvh flex flex-col bg-background overflow-hidden">
      <header className="min-h-14 border-b border-border bg-card flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4 sm:flex-nowrap sm:justify-between shrink-0">
        <div className="flex min-w-0 items-center gap-2 sm:gap-4">
          <Link href="/" className="p-2 hover:bg-muted rounded-md text-muted-foreground transition-colors" title="Back to Editor">
            <ArrowLeft size={18} />
          </Link>
          <div className="font-semibold flex items-center gap-2">
            <MessageSquare size={18} className="text-primary" />
            <span className="truncate">Inbox - {project.business.name}</span>
          </div>
        </div>
        <div className="w-full overflow-x-auto sm:w-auto">
          <SyncControls receptionistId={receptionistId} ownerKey={ownerKey} />
        </div>
      </header>
      
      <div className="flex-1 flex overflow-hidden">
        {/* Left List */}
      <div className={cn("w-full md:w-80 border-r border-border bg-card/50 flex-col shrink-0", selectedId ? "hidden md:flex" : "flex")}>
          <div className="p-3 border-b border-border space-y-3 shrink-0">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 text-muted-foreground" size={14} />
              <Input placeholder="Search conversations..." className="pl-8 h-8 text-sm" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Select value={channelFilter} onChange={e => setChannelFilter(e.target.value)} className="h-8 text-xs py-0">
                <option value="all">All Channels</option>
                <option value="chat">Web Chat</option>
                <option value="email">Email</option>
                <option value="call">Voice Call</option>
              </Select>
              <Select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="h-8 text-xs py-0">
                <option value="all">All Status</option>
                <option value="open">Open</option>
                <option value="escalated">Escalated</option>
                <option value="closed">Closed</option>
              </Select>
            </div>
          </div>
          
          <ConversationList 
            receptionistId={receptionistId} 
            ownerKey={ownerKey}
            channelFilter={channelFilter}
            statusFilter={statusFilter}
            selectedId={selectedId}
            onSelect={setSelectedId}
            searchQuery={searchQuery}
          />
        </div>
        
        {/* Right Detail */}
        <div className={cn("flex-1 bg-background relative flex-col", selectedId ? "flex" : "hidden md:flex")}>
          {selectedId ? (
            <ConversationDetailView 
              receptionistId={receptionistId}
              ownerKey={ownerKey}
              conversationId={selectedId}
              onBack={() => setSelectedId(null)}
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground bg-muted/5">
              <Mailbox size={48} className="opacity-20 mb-4" />
              <p>Select a conversation to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SyncControls({ receptionistId, ownerKey }: { receptionistId: string, ownerKey: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const syncGmail = useSyncGmail({ request: { headers: { 'X-SiteForge-Owner-Key': ownerKey } } });
  const syncRetell = useSyncRetellCalls({ request: { headers: { 'X-SiteForge-Owner-Key': ownerKey } } });
  
  const handleGmailSync = async () => {
    try {
      const res = await syncGmail.mutateAsync({ receptionistId });
      toast({ title: 'Gmail Synced', description: `Checked ${res.threadsChecked} threads, found ${res.newMessages} new, created ${res.suggestionsCreated} drafts.` });
      queryClient.invalidateQueries({ queryKey: getListReceptionistConversationsQueryKey(receptionistId) });
    } catch (error: unknown) {
      toast({ title: 'Gmail Sync Failed', description: errorMessage(error), variant: 'destructive' });
    }
  };

  const handleRetellSync = async () => {
    try {
      const res = await syncRetell.mutateAsync({ receptionistId });
      toast({ title: 'Retell Synced', description: `Checked ${res.callsChecked} calls, created ${res.newConversations} conversations.` });
      queryClient.invalidateQueries({ queryKey: getListReceptionistConversationsQueryKey(receptionistId) });
    } catch (error: unknown) {
      toast({ title: 'Retell Sync Failed', description: errorMessage(error), variant: 'destructive' });
    }
  };

  return (
    <div className="flex min-w-max items-center gap-2">
      <span className="hidden text-xs text-muted-foreground lg:inline">Voice AI disabled — transcript sync only</span>
      <Button variant="outline" size="sm" onClick={handleGmailSync} disabled={syncGmail.isPending} className="gap-2 text-xs h-8">
        {syncGmail.isPending ? <Loader2 size={12} className="animate-spin" /> : <Mail size={12} />}
        Sync Gmail
      </Button>
      <Button variant="outline" size="sm" onClick={handleRetellSync} disabled={syncRetell.isPending} className="gap-2 text-xs h-8">
        {syncRetell.isPending ? <Loader2 size={12} className="animate-spin" /> : <PhoneCall size={12} />}
        Sync Calls
      </Button>
    </div>
  );
}

function ConversationList({ receptionistId, ownerKey, channelFilter, statusFilter, selectedId, onSelect, searchQuery = '' }: {
  receptionistId: string;
  ownerKey: string;
  channelFilter: string;
  statusFilter: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  searchQuery?: string;
}) {
  const { data, isLoading, error } = useListReceptionistConversations(receptionistId, {
    query: { refetchInterval: 8000, queryKey: getListReceptionistConversationsQueryKey(receptionistId) },
    request: { headers: { 'X-SiteForge-Owner-Key': ownerKey } }
  });

  if (isLoading) return <div className="p-4 text-center text-muted-foreground text-sm flex items-center justify-center gap-2"><Loader2 size={14} className="animate-spin"/> Loading...</div>;
  if (error) return <div className="p-4 text-center text-destructive text-sm">Failed to load conversations</div>;
  
  let convs = data?.conversations || [];
  if (channelFilter !== 'all') convs = convs.filter(c => c.channel === channelFilter);
  if (statusFilter !== 'all') convs = convs.filter(c => c.status === statusFilter);
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase();
    convs = convs.filter(c =>
      c.subject?.toLowerCase().includes(q) ||
      c.channel.toLowerCase().includes(q) ||
      c.status.toLowerCase().includes(q)
    );
  }

  if (convs.length === 0) return <div className="p-8 text-center text-muted-foreground text-sm">No conversations found</div>;

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar">
      {convs.map(conv => (
        <button
          key={conv.conversationId}
          onClick={() => onSelect(conv.conversationId)}
          className={cn(
            "w-full text-left p-3 border-b border-border hover:bg-muted/50 transition-colors flex flex-col gap-1",
            selectedId === conv.conversationId ? "bg-primary/5 border-l-2 border-l-primary" : "border-l-2 border-l-transparent"
          )}
        >
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-1.5 font-medium text-sm">
              {conv.channel === 'chat' && <MessageSquare size={12} className="text-blue-500" />}
              {conv.channel === 'email' && <Mail size={12} className="text-orange-500" />}
              {conv.channel === 'call' && <PhoneCall size={12} className="text-green-500" />}
              <span className="truncate max-w-[140px]">{conv.subject || 'Visitor'}</span>
            </div>
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
              {format(new Date(conv.updatedAt), 'MMM d, h:mm a')}
            </span>
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className={cn(
              "text-[10px] px-1.5 py-0.5 rounded-sm uppercase tracking-wider font-semibold",
              conv.status === 'open' ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" :
              conv.status === 'escalated' ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" :
              "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
            )}>
              {conv.status}
            </span>
            <span className="text-xs text-muted-foreground">{conv.messageCount} msg</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function ConversationDetailView({ receptionistId, ownerKey, conversationId, onBack }: { receptionistId: string, ownerKey: string, conversationId: string, onBack: () => void }) {
  const { data, isLoading } = useGetConversation(receptionistId, conversationId, {
    query: { refetchInterval: 5000, queryKey: getGetConversationQueryKey(receptionistId, conversationId) },
    request: { headers: { 'X-SiteForge-Owner-Key': ownerKey } }
  });

  if (isLoading) return <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="animate-spin text-primary" /></div>;
  if (!data) return <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">Not found</div>;

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-border bg-card shrink-0 flex justify-between items-center shadow-sm z-10">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={onBack} className="md:hidden shrink-0"><ArrowLeft size={18} /></Button>
          <div>
            <h2 className="font-semibold text-lg">{data.subject || 'Visitor Conversation'}</h2>
            <div className="text-xs text-muted-foreground flex items-center gap-2 mt-1">
              <span className="uppercase">{data.channel}</span>
              <span>•</span>
              <span>Started {format(new Date(data.createdAt), 'PP p')}</span>
              {data.externalId && <span>• ID: {data.externalId}</span>}
            </div>
          </div>
         <ConversationStatusAction
           receptionistId={receptionistId}
           conversationId={conversationId}
           ownerKey={ownerKey}
           status={data.status}
           expectedUpdatedAt={data.updatedAt}
         />
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar bg-muted/10">
        {data.messages.map((msg) => (
          <MessageBubble key={msg.messageId} msg={msg} receptionistId={receptionistId} ownerKey={ownerKey} />
        ))}
        {data.auditEvents.length > 0 && (
          <details className="rounded-xl border border-border bg-card/80 p-3 text-sm shadow-sm">
            <summary className="flex cursor-pointer list-none items-center gap-2 font-medium text-card-foreground">
              <Activity size={14} className="text-primary" />
              Activity history
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                {data.auditEvents.length} events
              </span>
            </summary>
            <div className="mt-3 space-y-2 border-t border-border pt-3">
              {data.auditEvents.map(event => (
                <div key={event.auditEventId} className="flex items-start justify-between gap-3 text-xs">
                  <span>{formatEventType(event.eventType)}</span>
                  <time className="shrink-0 text-muted-foreground" dateTime={event.createdAt}>
                    {format(new Date(event.createdAt), 'MMM d, h:mm a')}
                  </time>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {data.channel === 'chat' && data.status !== 'closed' && (
        <ReplyBox receptionistId={receptionistId} conversationId={conversationId} ownerKey={ownerKey} />
      )}
    </div>
  );
}

function ConversationStatusAction({ receptionistId, conversationId, ownerKey, status, expectedUpdatedAt }: {
  receptionistId: string;
  conversationId: string;
  ownerKey: string;
  status: string;
  expectedUpdatedAt: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateStatus = useUpdateConversationStatus({
    request: { headers: { 'X-SiteForge-Owner-Key': ownerKey } },
  });
  const isClosed = status === 'closed';

  const handleStatusChange = async () => {
    try {
      await updateStatus.mutateAsync({
        receptionistId,
        conversationId,
        data: {
          status: isClosed ? 'open' : 'closed',
          expectedUpdatedAt,
        },
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetConversationQueryKey(receptionistId, conversationId) }),
        queryClient.invalidateQueries({ queryKey: getListReceptionistConversationsQueryKey(receptionistId) }),
      ]);
      toast({
        title: isClosed ? 'Conversation Reopened' : 'Conversation Resolved',
        description: isClosed
          ? 'This conversation is open for follow-up again.'
          : 'This conversation has been marked as resolved.',
      });
    } catch (error: unknown) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetConversationQueryKey(receptionistId, conversationId) }),
        queryClient.invalidateQueries({ queryKey: getListReceptionistConversationsQueryKey(receptionistId) }),
      ]);
      toast({
        title: 'Status Update Failed',
        description: errorMessage(error),
        variant: 'destructive',
      });
    }
  };

  return (
    <Button
      variant={isClosed ? 'outline' : 'default'}
      size="sm"
      onClick={handleStatusChange}
      disabled={updateStatus.isPending}
      className="shrink-0"
    >
      {updateStatus.isPending
        ? <Loader2 size={14} className="animate-spin" />
        : isClosed ? 'Reopen' : 'Resolve'}
    </Button>
  );
}

function MessageBubble({ msg, receptionistId, ownerKey }: { msg: ChatMessage, receptionistId: string, ownerKey: string }) {
  const isAgent = msg.role === 'assistant';
  const isOwner = msg.role === 'owner';
  const isUser = msg.role === 'user';
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const approveDraft = useApproveEmailDraft({ request: { headers: { 'X-SiteForge-Owner-Key': ownerKey } } });
  const recoverDraft = useRecoverEmailDraft({ request: { headers: { 'X-SiteForge-Owner-Key': ownerKey } } });
  const rejectDraft = useRejectEmailDraft({ request: { headers: { 'X-SiteForge-Owner-Key': ownerKey } } });

  const handleApprove = async () => {
    try {
      await approveDraft.mutateAsync({ receptionistId, messageId: msg.messageId });
      queryClient.setQueryData<ConversationDetail>(
        getGetConversationQueryKey(receptionistId, msg.conversationId),
        (old) => {
        if (!old) return old;
        return {
          ...old,
          messages: old.messages.map((message) =>
            message.messageId === msg.messageId
              ? { ...message, approvalState: 'approved' }
              : message
          )
        };
        },
      );
      toast({ title: 'Draft Approved', description: 'Draft has been added to Gmail.' });
    } catch(err) {
      toast({ title: 'Approval Failed', variant: 'destructive' });
    }
  };

  const handleRecover = async () => {
    try {
      await recoverDraft.mutateAsync({ receptionistId, messageId: msg.messageId });
      queryClient.setQueryData<ConversationDetail>(
        getGetConversationQueryKey(receptionistId, msg.conversationId),
        (old) => {
          if (!old) return old;
          return {
            ...old,
            messages: old.messages.map((message) =>
              message.messageId === msg.messageId
                ? { ...message, approvalState: 'approved' }
                : message
            )
          };
        },
      );
      toast({
        title: 'Draft Recovered',
        description: 'The existing Gmail draft was found safely.',
      });
    } catch (error: unknown) {
      await queryClient.invalidateQueries({
        queryKey: getGetConversationQueryKey(receptionistId, msg.conversationId),
      });
      toast({
        title: 'Recovery Check Finished',
        description: errorMessage(error),
        variant: 'destructive',
      });
    }
  };

  const handleReject = async () => {
    try {
      await rejectDraft.mutateAsync({ receptionistId, messageId: msg.messageId });
      queryClient.setQueryData<ConversationDetail>(
        getGetConversationQueryKey(receptionistId, msg.conversationId),
        (old) => {
        if (!old) return old;
        return {
          ...old,
          messages: old.messages.map((message) =>
            message.messageId === msg.messageId
              ? { ...message, approvalState: 'rejected' }
              : message
          )
        };
        },
      );
      toast({ title: 'Draft Rejected' });
    } catch(err) {
      toast({ title: 'Rejection Failed', variant: 'destructive' });
    }
  };

  return (
    <div className={cn("flex flex-col max-w-[80%]", 
      isAgent ? "self-start" : isOwner ? "self-end items-end" : "self-start"
    )}>
      <div className="text-[10px] text-muted-foreground mb-1 ml-1 flex gap-2">
        <span className="font-semibold capitalize">{msg.role}</span>
        <span>{format(new Date(msg.createdAt), 'h:mm a')}</span>
      </div>
      <div className={cn(
        "p-3 rounded-2xl text-sm whitespace-pre-wrap shadow-sm leading-relaxed",
        isAgent ? "bg-card border border-border text-card-foreground rounded-tl-none" : 
        isOwner ? "bg-primary text-primary-foreground rounded-tr-none" : 
        "bg-secondary text-secondary-foreground rounded-tl-none"
      )}>
        {msg.content}
      </div>
      
      {msg.approvalState === 'pending' && (
        <div className="mt-2 bg-amber-50 border border-amber-200 dark:bg-amber-900/20 dark:border-amber-900 rounded-lg p-3 text-amber-900 dark:text-amber-200 text-sm shadow-sm self-start">
          <p className="font-medium mb-2 flex items-center gap-1.5"><CheckCircle size={14}/> AI Draft Suggestion</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleApprove} disabled={approveDraft.isPending} className="bg-emerald-600 hover:bg-emerald-700 text-white h-7 text-xs">
              {approveDraft.isPending ? '...' : 'Approve & Create Draft'}
            </Button>
            <Button size="sm" variant="outline" onClick={handleReject} disabled={rejectDraft.isPending} className="border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/50 h-7 text-xs">
              Discard
            </Button>
          </div>
        </div>
      )}
      {(msg.approvalState === 'approving' || msg.approvalState === 'reconciling') && (
        <div className="mt-2 bg-amber-50 border border-amber-200 dark:bg-amber-900/20 dark:border-amber-900 rounded-lg p-3 text-amber-900 dark:text-amber-200 text-sm shadow-sm self-start">
          <p className="font-medium mb-2">Gmail draft confirmation was interrupted.</p>
          <Button
            size="sm"
            variant="outline"
            onClick={handleRecover}
            disabled={recoverDraft.isPending}
            className="border-amber-300 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-900/50 h-7 text-xs"
          >
            {recoverDraft.isPending ? 'Checking Gmail...' : 'Recover Safely'}
          </Button>
        </div>
      )}
      {msg.approvalState === 'approved' && <div className="text-[10px] mt-1 text-emerald-600 ml-1 font-medium flex items-center gap-1"><CheckCircle size={10} /> Draft created in Gmail</div>}
      {msg.approvalState === 'rejected' && <div className="text-[10px] mt-1 text-muted-foreground ml-1 font-medium flex items-center gap-1"><XCircle size={10} /> Draft rejected</div>}
    </div>
  );
}

function ReplyBox({ receptionistId, conversationId, ownerKey }: { receptionistId: string, conversationId: string, ownerKey: string }) {
  const [content, setContent] = useState('');
  const reply = useOwnerReply({ request: { headers: { 'X-SiteForge-Owner-Key': ownerKey } } });
  const queryClient = useQueryClient();
  
  const handleSend = async () => {
    if (!content.trim()) return;
    try {
      const newMessage = await reply.mutateAsync({ receptionistId, conversationId, data: { content } });
      setContent('');
      queryClient.setQueryData<ConversationDetail>(
        getGetConversationQueryKey(receptionistId, conversationId),
        (old) => {
        if (!old) return old;
        return {
          ...old,
          messages: [...old.messages, newMessage]
        };
        },
      );
    } catch(err) {
      console.error(err);
    }
  };

  return (
    <div className="p-3 border-t border-border bg-card shrink-0 shadow-[0_-4px_10px_rgba(0,0,0,0.02)] z-10">
      <div className="relative">
        <Textarea 
          value={content}
          onChange={e => setContent(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Type your reply..."
          className="min-h-[80px] pb-10 resize-none text-sm"
        />
        <Button 
          size="sm" 
          onClick={handleSend}
          disabled={!content.trim() || reply.isPending}
          className="absolute bottom-2 right-2 h-7"
        >
          {reply.isPending ? <Loader2 size={14} className="animate-spin" /> : 'Send'}
        </Button>
      </div>
    </div>
  );
}
