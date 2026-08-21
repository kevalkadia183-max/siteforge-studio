import { useState } from 'react';
import { Link } from 'wouter';
import { ArrowLeft, Settings, ShieldAlert, Loader2, Save, Mail, MessageSquare, Image as ImageIcon, MapPin, Activity, CheckCircle2, XCircle } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetProviderSettings,
  useUpdateProviderSetting,
  useListProviderAuditEvents,
  getGetProviderSettingsQueryKey,
  getListProviderAuditEventsQueryKey,
  type ProviderCapability,
  type ProviderCapabilitySetting,
  type ProviderSettingUpdate,
  type ProviderAuditEvent
} from '@workspace/api-client-react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { format } from 'date-fns';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

function CapabilityIcon({ capability }: { capability: string }) {
  switch (capability) {
    case 'email': return <Mail className="text-blue-500" />;
    case 'whatsapp': return <MessageSquare className="text-green-500" />;
    case 'image': return <ImageIcon className="text-purple-500" />;
    case 'discovery': return <MapPin className="text-amber-500" />;
    case 'website_analysis': return <Activity className="text-indigo-500" />;
    default: return <Settings className="text-muted-foreground" />;
  }
}

function CapabilityCard({ 
  setting, 
  onSave 
}: { 
  setting: ProviderCapabilitySetting,
  onSave: (capability: ProviderCapability, data: ProviderSettingUpdate) => Promise<void> 
}) {
  const [isSaving, setIsSaving] = useState(false);
  const { capability, providerKey, displayName, enabled, availability, message, config, quota } = setting;
  
  // Specific states for WhatsApp
  const [waTemplateName, setWaTemplateName] = useState(config?.whatsappTemplateName || '');
  const [waTemplateLanguage, setWaTemplateLanguage] = useState(config?.whatsappTemplateLanguage || '');
  
  const handleToggle = async (checked: boolean) => {
    setIsSaving(true);
    try {
      await onSave(capability, { enabled: checked });
    } finally {
      setIsSaving(false);
    }
  };
  
  const handleWhatsAppSave = async () => {
    setIsSaving(true);
    try {
      await onSave(capability, { 
        config: { 
          whatsappTemplateName: waTemplateName.trim() || null, 
          whatsappTemplateLanguage: waTemplateLanguage.trim() || null,
          requireExplicitConsent: true
        } 
      });
    } finally {
      setIsSaving(false);
    }
  };

  const canToggle = providerKey != null;

  return (
    <div className="bg-card border border-border rounded-xl shadow-sm p-5 space-y-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-muted/50 flex items-center justify-center">
            <CapabilityIcon capability={capability} />
          </div>
          <div>
            <h3 className="font-semibold text-foreground capitalize" data-testid={`text-capability-${capability}`}>
              {displayName || capability.replace('_', ' ')}
            </h3>
            <div className="flex items-center gap-2 mt-1">
              {availability === 'available' && <span className="inline-flex items-center text-xs font-medium text-emerald-600 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-0.5 rounded-full"><CheckCircle2 size={12} className="mr-1" /> Active</span>}
              {availability === 'disabled' && <span className="inline-flex items-center text-xs font-medium text-slate-600 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded-full"><XCircle size={12} className="mr-1" /> Disabled</span>}
              {availability === 'not_configured' && <span className="inline-flex items-center text-xs font-medium text-amber-600 bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 rounded-full"><ShieldAlert size={12} className="mr-1" /> Not Configured</span>}
              {availability === 'rate_limited' && <span className="inline-flex items-center text-xs font-medium text-rose-600 bg-rose-50 dark:bg-rose-900/20 px-2 py-0.5 rounded-full"><Activity size={12} className="mr-1" /> Rate Limited</span>}
              {availability === 'unavailable' && <span className="inline-flex items-center text-xs font-medium text-rose-600 bg-rose-50 dark:bg-rose-900/20 px-2 py-0.5 rounded-full"><XCircle size={12} className="mr-1" /> Unavailable</span>}
            </div>
          </div>
        </div>
        
        {canToggle && (
          <div className="flex items-center gap-2">
            {isSaving && <Loader2 size={14} className="animate-spin text-muted-foreground" />}
            <Switch 
              checked={enabled} 
              onCheckedChange={handleToggle} 
              disabled={isSaving}
              data-testid={`switch-${capability}`}
            />
          </div>
        )}
      </div>

      {message && (
        <div className="text-sm text-muted-foreground bg-muted/30 p-3 rounded-md" data-testid={`status-message-${capability}`}>
          {message}
        </div>
      )}

      {quota && (
        <div className="bg-muted/10 border border-border rounded-lg p-3" data-testid={`quota-${capability}`}>
          <div className="flex justify-between items-end mb-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Usage Quota</span>
            <span className="text-xs font-medium text-foreground">{quota.used} / {quota.limit}</span>
          </div>
          <div className="w-full h-1.5 bg-muted rounded-full overflow-hidden">
            <div 
              className={`h-full ${quota.used >= quota.limit ? 'bg-destructive' : 'bg-primary'}`} 
              style={{ width: `${Math.min(100, (quota.used / quota.limit) * 100)}%` }}
            />
          </div>
          <div className="text-[10px] text-muted-foreground mt-2 text-right">
            Resets at {format(new Date(quota.windowEndsAt), 'MMM d, h:mm a')}
          </div>
        </div>
      )}

      {capability === 'whatsapp' && (
        <div className="border-t border-border pt-4 mt-2 space-y-4">
          <div className="grid gap-3">
            <div className="space-y-1">
              <Label htmlFor="whatsapp-template-name" className="text-xs text-muted-foreground">Approved Template Name</Label>
              <Input 
                id="whatsapp-template-name"
                value={waTemplateName} 
                onChange={e => setWaTemplateName(e.target.value)} 
                placeholder="e.g. outreach_intro_v1"
                maxLength={128}
                className="h-8 text-sm"
                data-testid="input-whatsapp-template-name"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="whatsapp-template-language" className="text-xs text-muted-foreground">Template Language</Label>
              <Input 
                id="whatsapp-template-language"
                value={waTemplateLanguage} 
                onChange={e => setWaTemplateLanguage(e.target.value)} 
                placeholder="e.g. en_US"
                maxLength={16}
                className="h-8 text-sm"
                data-testid="input-whatsapp-template-language"
              />
            </div>
            <div className="flex items-center space-x-2 bg-muted/30 p-2 rounded-md">
              <Switch checked={true} disabled data-testid="switch-whatsapp-consent" />
              <Label className="text-xs font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                Require explicit consent before sending (Mandatory)
              </Label>
            </div>
          </div>
          <Button 
            size="sm" 
            variant="outline" 
            onClick={handleWhatsAppSave} 
            disabled={isSaving}
            className="w-full"
            data-testid="button-whatsapp-save"
          >
            {isSaving ? <Loader2 size={14} className="animate-spin mr-2" /> : <Save size={14} className="mr-2" />}
            Save WhatsApp Prep
          </Button>
        </div>
      )}

      {capability === 'discovery' && availability === 'not_configured' && (
        <div className="border-t border-border pt-4 mt-2">
          <p className="text-sm text-muted-foreground">
            No live discovery provider is configured for this workspace. Connect an external provider account to enable live lead acquisition.
          </p>
        </div>
      )}
    </div>
  );
}

function AuditLog() {
  const { data, isLoading, error, refetch } = useListProviderAuditEvents({ limit: 25 }, {
    query: { queryKey: getListProviderAuditEventsQueryKey({ limit: 25 }) }
  });

  if (isLoading) {
    return (
      <div className="h-48 flex items-center justify-center">
        <Loader2 className="animate-spin text-muted-foreground" size={24} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-destructive/10 text-destructive p-4 rounded-lg flex flex-col items-start gap-2">
        <div className="flex items-center gap-2 font-medium" data-testid="status-audit-error">
          <ShieldAlert size={16} /> Error loading audit log
        </div>
        <p className="text-xs">{getErrorMessage(error)}</p>
        <Button size="sm" variant="outline" onClick={() => refetch()} data-testid="button-audit-retry">Retry</Button>
      </div>
    );
  }

  if (!data?.items || data.items.length === 0) {
    return (
      <div className="text-center p-8 bg-muted/10 rounded-xl border border-border border-dashed" data-testid="status-audit-empty">
        <Activity className="mx-auto mb-2 opacity-20" size={32} />
        <p className="text-sm text-muted-foreground">No recent provider activity.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {data.items.map((event: ProviderAuditEvent) => (
        <div key={event.id} className="text-sm bg-card border border-border p-3 rounded-lg flex gap-3 items-start" data-testid={`audit-event-${event.id}`}>
          <div className="mt-0.5">
            {event.outcome === 'success' ? (
              <CheckCircle2 size={16} className="text-emerald-500" />
            ) : (
              <XCircle size={16} className="text-destructive" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-foreground capitalize truncate">{event.capability} <span className="text-muted-foreground font-normal mx-1">&middot;</span> {event.eventType}</span>
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">{format(new Date(event.occurredAt), 'MMM d, h:mm a')}</span>
            </div>
            {event.detail && (
              <p className="text-muted-foreground text-xs mt-1 break-words">{event.detail}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  
  const { data: settingsData, isLoading: settingsLoading, error: settingsError, refetch: refetchSettings } = useGetProviderSettings({
    query: { queryKey: getGetProviderSettingsQueryKey() }
  });

  const updateSetting = useUpdateProviderSetting();

  const handleSaveSetting = async (capability: ProviderCapability, data: ProviderSettingUpdate) => {
    try {
      await updateSetting.mutateAsync({ capability, data });
      queryClient.invalidateQueries({ queryKey: getGetProviderSettingsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListProviderAuditEventsQueryKey({ limit: 25 }) });
      toast({
        title: "Setting updated",
        description: `Successfully updated ${capability} configuration.`,
      });
    } catch (err) {
      toast({
        title: "Update failed",
        description: getErrorMessage(err),
        variant: "destructive"
      });
    }
  };

  return (
    <div className="h-dvh flex flex-col bg-background text-foreground overflow-hidden">
      <header className="min-h-14 border-b border-border bg-card flex flex-col sm:flex-row sm:items-center px-4 py-3 sm:py-0 shrink-0 z-10 justify-between gap-3 sm:gap-0">
        <div className="flex items-center gap-2 sm:gap-4 w-full sm:w-auto">
          <Link href="/studio" className="p-1.5 hover:bg-muted rounded-md text-muted-foreground transition-colors shrink-0" title="Back to Editor" data-testid="link-back-to-studio">
            <ArrowLeft size={18} />
          </Link>
          <div className="flex items-center gap-2 font-semibold min-w-0">
            <Settings size={18} className="text-primary shrink-0" />
            <span className="truncate text-base sm:text-sm">Provider Configuration</span>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar bg-muted/5">
        <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8">
          
          <div className="lg:col-span-2 space-y-6">
            <div>
              <h2 className="text-lg font-bold tracking-tight mb-1">Capabilities</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Manage backend provider integrations for outreach, discovery, and enrichment.
              </p>
            </div>
            
            {settingsLoading ? (
              <div className="h-64 flex flex-col items-center justify-center gap-3">
                <Loader2 className="animate-spin text-primary" size={32} />
                 <span className="text-sm text-muted-foreground" data-testid="status-settings-loading">Loading provider settings...</span>
              </div>
            ) : settingsError ? (
              <div className="bg-destructive/10 border border-destructive/20 text-destructive p-6 rounded-xl flex flex-col items-center justify-center text-center gap-4" data-testid="status-settings-error">
                <ShieldAlert size={32} />
                <div>
                  <h3 className="font-semibold mb-1">Failed to load configuration</h3>
                  <p className="text-sm opacity-90">{getErrorMessage(settingsError)}</p>
                </div>
                <Button onClick={() => refetchSettings()} variant="outline" data-testid="button-settings-retry">Retry</Button>
              </div>
            ) : settingsData?.capabilities.length === 0 ? (
              <div className="bg-muted/20 border border-dashed border-border p-8 rounded-xl text-center text-sm text-muted-foreground" data-testid="status-settings-empty">
                No provider capabilities are available.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {settingsData?.capabilities.map((setting: ProviderCapabilitySetting) => (
                  <CapabilityCard 
                    key={setting.capability} 
                    setting={setting} 
                    onSave={handleSaveSetting} 
                  />
                ))}
              </div>
            )}
          </div>

          <div className="space-y-6">
            <div>
              <h2 className="text-lg font-bold tracking-tight mb-1">Audit Log</h2>
              <p className="text-sm text-muted-foreground mb-4">
                Recent provider operations and events.
              </p>
            </div>
            <div className="bg-card rounded-xl border border-border p-4 shadow-sm min-h-[400px]">
              <AuditLog />
            </div>
          </div>
          
        </div>
      </div>
    </div>
  );
}
