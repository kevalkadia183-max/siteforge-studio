import React, { useEffect, useState } from 'react';
import {
  BriefDraft,
  BriefDraftSelection,
  ClientBrief,
  MediaAsset,
  SiteProject,
  PageId,
  SectionData,
  TemplateId,
} from '../lib/types';
import { createReceptionistStarter, TEMPLATES } from '../lib/templates';
import {
  createBriefDraft,
  createBriefDraftSelection,
  getSelectedBriefDraftChangeCount,
} from '../lib/brief-generator';
import {
  getProjectMediaStats,
  MAX_PROJECT_MEDIA_ASSETS,
  MAX_PROJECT_MEDIA_DATA_LENGTH,
} from '../lib/media';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Input, Label, Select, Textarea, Button, Switch } from './ui/forms';
import { Eye, EyeOff, ImagePlus, Plus, Trash2, ArrowUp, ArrowDown, X, Bot, PhoneCall, Loader2, Wand2, Check } from 'lucide-react';
import { cn } from '../lib/utils';
import { createReceptionist, useUpdateReceptionistSettings, updateReceptionistSettings } from '@workspace/api-client-react';
import { useToast } from '../hooks/use-toast';
import { isAllowedHostedApiUrl } from '../lib/generator';

type SidebarProps = {
  project: SiteProject;
  updateBusiness: (updates: Partial<SiteProject['business']>) => void;
  updateTokens: (updates: Partial<SiteProject['designTokens']>) => void;
  updateSection: (pageId: PageId, sectionId: string, updates: Partial<SectionData>) => void;
  applyBriefDraft: (draft: BriefDraft, selection: BriefDraftSelection) => Promise<boolean>;
  moveSection: (pageId: PageId, sectionId: string, direction: 'up' | 'down') => void;
  toggleSectionVisibility: (pageId: PageId, sectionId: string) => void;
  switchTemplate: (templateId: TemplateId) => void;
  updateReceptionist: (updates: Partial<NonNullable<SiteProject['receptionist']>>) => void;
};

const COLORS = [
  { name: 'Coral', value: '#ef5d3f' },
  { name: 'Navy', value: '#1e3a8a' },
  { name: 'Amber', value: '#d97706' },
  { name: 'Emerald', value: '#059669' },
  { name: 'Dark Gray', value: '#171717' },
  { name: 'Rose', value: '#e11d48' },
  { name: 'Violet', value: '#7c3aed' },
  { name: 'Slate', value: '#475569' },
];

const FONT_PAIRS = [
  { name: 'Modern & Bold', heading: 'Manrope', body: 'Inter' },
  { name: 'Editorial & Trusted', heading: 'Playfair Display', body: 'Inter' },
  { name: 'Warm & Artisanal', heading: 'Fraunces', body: 'DM Sans' },
  { name: 'Calm & Friendly', heading: 'Outfit', body: 'Outfit' },
  { name: 'Sharp & Creative', heading: 'Space Mono', body: 'Inter' },
];

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_STORED_IMAGE_SIZE = 300 * 1024;
const IMAGE_TYPES = new Set<MediaAsset['mimeType']>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => typeof reader.result === 'string'
    ? resolve(reader.result)
    : reject(new Error('Invalid image data'));
  reader.onerror = () => reject(reader.error || new Error('Image read failed'));
  reader.readAsDataURL(blob);
});

const canvasToBlob = (canvas: HTMLCanvasElement, quality: number) => new Promise<Blob>((resolve, reject) => {
  canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('Image optimization failed')),
    'image/webp',
    quality,
  );
});

async function optimizeImage(file: File): Promise<{ blob: Blob; mimeType: MediaAsset['mimeType'] }> {
  if (file.type === 'image/gif') {
    if (file.size > MAX_STORED_IMAGE_SIZE) {
      throw new Error('Animated GIFs must be smaller than 300 KB.');
    }
    return { blob: file, mimeType: 'image/gif' };
  }

  const source = await createImageBitmap(file);
  try {
    const attempts = [
      { maxDimension: 1600, quality: 0.82 },
      { maxDimension: 1280, quality: 0.76 },
      { maxDimension: 960, quality: 0.7 },
    ];
    let optimized: Blob | null = null;

    for (const attempt of attempts) {
      const scale = Math.min(1, attempt.maxDimension / Math.max(source.width, source.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(source.width * scale));
      canvas.height = Math.max(1, Math.round(source.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Image optimization is unavailable.');
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      optimized = await canvasToBlob(canvas, attempt.quality);
      if (optimized.size <= MAX_STORED_IMAGE_SIZE) break;
    }

    if (!optimized || optimized.size > MAX_STORED_IMAGE_SIZE) {
      throw new Error('This image is too detailed to optimize. Try a smaller image.');
    }
    return { blob: optimized, mimeType: 'image/webp' };
  } finally {
    source.close();
  }
}

async function createMediaAsset(file: File, onReady: (asset: MediaAsset) => void) {
  if (!IMAGE_TYPES.has(file.type as MediaAsset['mimeType'])) {
    window.alert('Choose a PNG, JPEG, WebP, GIF, or AVIF image.');
    return;
  }
  if (file.size > MAX_IMAGE_SIZE) {
    window.alert('Choose an image smaller than 5 MB.');
    return;
  }

  try {
    const optimized = await optimizeImage(file);
    const dataUrl = await blobToDataUrl(optimized.blob);
    onReady({
      id: crypto.randomUUID?.() || Math.random().toString(36).slice(2),
      name: file.name,
      mimeType: optimized.mimeType,
      dataUrl,
    });
  } catch (error) {
    window.alert(error instanceof Error ? error.message : 'That image could not be read. Please try another file.');
  }
}

function ImagePicker({
  label,
  asset,
  onChange,
  id,
  className = 'aspect-[4/3]',
}: {
  label: string;
  asset?: MediaAsset;
  onChange: (asset?: MediaAsset) => void;
  id: string;
  className?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-xs">{label}</Label>
        {asset && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive"
            aria-label={`Remove ${label.toLowerCase()}`}
          >
            <X size={12} /> Remove
          </button>
        )}
      </div>
      <div className={`relative overflow-hidden rounded-md border border-dashed border-border bg-muted/30 ${className}`}>
        {asset ? (
          <img src={asset.dataUrl} alt={`${label} preview`} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center px-3 text-center text-[11px] text-muted-foreground">
            <ImagePlus size={18} className="mb-1.5" />
            PNG, JPEG, WebP, GIF, or AVIF · max 5 MB
          </div>
        )}
        <label
          htmlFor={id}
          className="absolute inset-x-2 bottom-2 cursor-pointer rounded bg-background/90 px-2 py-1.5 text-center text-[11px] font-medium shadow-sm backdrop-blur transition-colors hover:bg-background"
        >
          {asset ? 'Replace image' : 'Upload image'}
        </label>
        <input
          id={id}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = '';
            if (file) void createMediaAsset(file, onChange);
          }}
          data-testid={`input-upload-${id}`}
        />
      </div>
    </div>
  );
}

function DraftSectionReview({
  current,
  proposed,
  included,
  onIncludedChange,
}: {
  current: SectionData;
  proposed: SectionData;
  included: boolean;
  onIncludedChange: (included: boolean) => void;
}) {
  const changedTextFields = (['title', 'subtitle', 'content'] as const)
    .filter((field) => current[field] !== proposed[field] && proposed[field] !== undefined);
  const itemsChanged = JSON.stringify(current.items) !== JSON.stringify(proposed.items) && proposed.items;

  return (
    <div className={cn(
      'rounded-md border p-2.5 space-y-2 transition-colors',
      included ? 'border-primary/40 bg-background' : 'border-dashed border-border bg-muted/20 opacity-70',
    )}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold capitalize text-foreground">{proposed.type.replace('-', ' ')}</p>
        <span className={cn(
          'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
          included ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}>
          {included ? 'Included' : 'Skipped'}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 border-y border-border/60 py-1.5">
        <Label className="text-[11px] text-muted-foreground">Include this section</Label>
        <Switch
          checked={included}
          onCheckedChange={onIncludedChange}
          aria-label={`Include ${proposed.type.replace('-', ' ')} section`}
          data-testid={`switch-brief-section-${proposed.id}`}
        />
      </div>
      {changedTextFields.map((field) => (
        <div key={field}>
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {field === 'content' && proposed.type === 'hero' ? 'Button text' : field}
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-foreground">{proposed[field]}</p>
        </div>
      ))}
      {itemsChanged && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Items</p>
          {proposed.items?.map((item, index) => (
            <div key={`${item.title}-${index}`} className="border-l-2 border-primary/30 pl-2">
              <p className="text-xs font-medium text-foreground">{item.title}</p>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{item.description}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function StudioSidebar({
  project,
  updateBusiness,
  updateTokens,
  updateSection,
  applyBriefDraft,
  moveSection,
  toggleSectionVisibility,
  switchTemplate,
  updateReceptionist
}: SidebarProps) {
  const activePage = project.pages[project.activePageId];
  const sectionOrder = project.sectionOrder[project.activePageId] || [];
  const hiddenSections = project.hiddenSections[project.activePageId] || [];
  const mediaStats = getProjectMediaStats(project);
  const [isCreatingReceptionist, setIsCreatingReceptionist] = useState(false);
  const [brief, setBrief] = useState<ClientBrief>({
    businessType: project.business.category,
    services: '',
    location: project.business.city,
    audience: '',
    differentiators: '',
    tone: 'professional',
  });
  const [draft, setDraft] = useState<BriefDraft | null>(null);
  const [draftSelection, setDraftSelection] = useState<BriefDraftSelection | null>(null);
  const [isApplyingDraft, setIsApplyingDraft] = useState(false);
  
  const { toast } = useToast();
  const updateSettings = useUpdateReceptionistSettings({ request: { headers: { 'X-SiteForge-Owner-Key': project.receptionist?.ownerKey || '' } } });

  useEffect(() => {
    setBrief({
      businessType: project.business.category,
      services: '',
      location: project.business.city,
      audience: '',
      differentiators: '',
      tone: 'professional',
    });
    setDraft(null);
    setDraftSelection(null);
  }, [project.id]);

  const updateBrief = <K extends keyof ClientBrief>(key: K, value: ClientBrief[K]) => {
    setBrief((current) => ({ ...current, [key]: value }));
  };

  const handleGenerateDraft = () => {
    if (!brief.businessType.trim() || !brief.services.trim() || !brief.location.trim() || !brief.audience.trim()) {
      toast({
        title: 'Add the key brief details',
        description: 'Business type, services, location, and audience are needed to make a useful first draft.',
        variant: 'destructive',
      });
      return;
    }
    const generatedDraft = createBriefDraft(project, brief);
    setDraft(generatedDraft);
    setDraftSelection(createBriefDraftSelection(generatedDraft));
  };

  const handleApplyDraft = async () => {
    if (!draft || !draftSelection) return;
    setIsApplyingDraft(true);
    const applied = await applyBriefDraft(draft, draftSelection);
    setIsApplyingDraft(false);
    if (!applied) {
      toast({
        title: 'Draft needs a refresh',
        description: 'The site changed while you were reviewing this draft. Generate it again to avoid replacing newer edits.',
        variant: 'destructive',
      });
      setDraft(null);
      setDraftSelection(null);
      return;
    }
    setDraft(null);
    setDraftSelection(null);
    toast({
      title: 'Selected draft changes applied',
      description: 'Your included changes remain editable. Use Undo to restore the previous site.',
    });
  };

  const setBusinessDraftSelection = (
    field: keyof BriefDraftSelection['business'],
    included: boolean,
  ) => {
    setDraftSelection((current) => current
      ? { ...current, business: { ...current.business, [field]: included } }
      : current,
    );
  };

  const setSectionDraftSelection = (
    pageId: PageId,
    sectionId: string,
    included: boolean,
  ) => {
    setDraftSelection((current) => current
      ? {
        ...current,
        sections: {
          ...current.sections,
          [pageId]: { ...current.sections[pageId], [sectionId]: included },
        },
      }
      : current,
    );
  };

  const selectedDraftChangeCount = draft && draftSelection
    ? getSelectedBriefDraftChangeCount(draft, draftSelection)
    : 0;
  const totalDraftChangeCount = draft
    ? getSelectedBriefDraftChangeCount(draft, createBriefDraftSelection(draft))
    : 0;

  const handleToggleReceptionist = async (enabled: boolean) => {
    if (!project.receptionist?.receptionistId && enabled) {
      setIsCreatingReceptionist(true);
      try {
        const res = await createReceptionist({
          businessName: project.business.name,
          businessEmail: project.business.email,
          assistantName: project.receptionist?.assistantName || 'Assistant'
        });
        updateReceptionist({
          enabled: true,
          receptionistId: res.receptionistId,
          ownerKey: res.ownerKey,
          provisionedAt: Date.now()
        });
        // Immediately sync settings using the raw API call
        await updateReceptionistSettings(res.receptionistId, {
          enabled: true,
          businessName: project.business.name,
          businessEmail: project.business.email,
          assistantName: project.receptionist?.assistantName || 'Assistant',
          greeting: project.receptionist?.greeting,
          knowledge: project.receptionist?.knowledge,
          faqs: project.receptionist?.faqs,
          hours: project.receptionist?.hours,
          serviceArea: project.receptionist?.serviceArea,
          escalationContact: project.receptionist?.escalationContact,
          prohibitedActions: project.receptionist?.prohibitedActions,
          safeAutoReplyCategories: project.receptionist?.safeAutoReplyCategories,
          retellAgentId: project.receptionist?.retellAgentId,
        }, { headers: { 'X-SiteForge-Owner-Key': res.ownerKey } });
        
        toast({ title: 'AI Receptionist activated' });
      } catch (err) {
        console.error(err);
        toast({
          title: 'Failed to create receptionist',
          description: err instanceof Error ? err.message : 'The setup request failed.',
          variant: 'destructive',
        });
      } finally {
        setIsCreatingReceptionist(false);
      }
    } else {
      updateReceptionist({ enabled });
      if (project.receptionist?.receptionistId && project.receptionist?.ownerKey) {
        try {
          await updateReceptionistSettings(project.receptionist.receptionistId, { enabled }, { headers: { 'X-SiteForge-Owner-Key': project.receptionist.ownerKey } });
        } catch(err) {
          console.error(err);
        }
      }
    }
  };

  const syncSetting = <K extends keyof NonNullable<SiteProject['receptionist']>>(
    key: K,
    value: NonNullable<SiteProject['receptionist']>[K],
  ) => {
    updateReceptionist({ [key]: value });
  };

  const handleSaveSettings = async () => {
    if (!project.receptionist?.receptionistId || !project.receptionist?.ownerKey) return;
    if (!isAllowedHostedApiUrl(project.receptionist.hostedApiUrl)) {
      toast({
        title: 'Invalid Hosted API URL',
        description: 'Use /api or an absolute URL beginning with http:// or https://.',
        variant: 'destructive',
      });
      return;
    }
    updateSettings.mutate({
      receptionistId: project.receptionist.receptionistId,
      data: {
        enabled: project.receptionist.enabled,
        businessName: project.business.name,
        businessEmail: project.business.email,
        assistantName: project.receptionist.assistantName,
        greeting: project.receptionist.greeting,
        knowledge: project.receptionist.knowledge,
        faqs: project.receptionist.faqs,
        hours: project.receptionist.hours,
        serviceArea: project.receptionist.serviceArea,
        escalationContact: project.receptionist.escalationContact,
        prohibitedActions: project.receptionist.prohibitedActions,
        safeAutoReplyCategories: project.receptionist.safeAutoReplyCategories,
        retellAgentId: project.receptionist.retellAgentId,
      }
    }, {
      onSuccess: () => toast({ title: 'Receptionist settings saved' }),
      onError: (err) => {
        console.error(err);
        toast({ title: 'Failed to save settings', variant: 'destructive' });
      }
    });
  };

  const handleApplyReceptionistStarter = () => {
    const template = TEMPLATES.find(item => item.id === project.templateId);
    if (
      !window.confirm(
        `Load the ${template?.name ?? 'template'} starter answers? This replaces the current greeting, knowledge, FAQs, hours, service area, and safety rules. Your receptionist connection and assistant name will be kept.`,
      )
    ) {
      return;
    }

    const starter = createReceptionistStarter(project.templateId, project.business);
    updateReceptionist({
      greeting: starter.greeting,
      knowledge: starter.knowledge,
      faqs: starter.faqs,
      hours: starter.hours,
      serviceArea: starter.serviceArea,
      escalationContact:
        project.receptionist?.escalationContact || starter.escalationContact,
      prohibitedActions: starter.prohibitedActions,
      safeAutoReplyCategories: starter.safeAutoReplyCategories,
    });
    toast({
      title: `${template?.name ?? 'Template'} starter answers loaded`,
      description: 'Review the defaults, then save the receptionist settings.',
    });
  };

  return (
    <div className="w-full h-full flex flex-col bg-card border-r border-border overflow-hidden">
      <div className="p-4 border-b border-border bg-muted/30">
        <h2 className="font-semibold text-lg" data-testid="sidebar-title">{activePage.name} Page</h2>
        <p className="text-xs text-muted-foreground mt-1">{sectionOrder.length} sections available</p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
        <Accordion type="multiple" defaultValue={['templates', 'content', 'design']} className="space-y-4">
          <AccordionItem value="templates" className="border-border">
            <AccordionTrigger className="hover:no-underline py-2" data-testid="accordion-templates">Template Library</AccordionTrigger>
            <AccordionContent className="space-y-2 pt-2">
              {TEMPLATES.map(template => {
                const selected = template.id === project.templateId;
                return (
                  <button
                    key={template.id}
                    onClick={() => switchTemplate(template.id)}
                    className={cn(
                      "w-full rounded-lg border p-2.5 text-left transition-all hover:-translate-y-0.5 hover:border-primary/60",
                      selected ? "border-primary bg-primary/5 shadow-sm" : "border-border bg-muted/10"
                    )}
                    aria-pressed={selected}
                    data-testid={`template-${template.id}`}
                  >
                    <span
                      className="mb-2 block h-14 rounded-md border border-white/10"
                      style={{
                        background: `linear-gradient(135deg, ${template.defaultTokens.primaryColor} 0 46%, #111827 46% 66%, #f8fafc 66%)`
                      }}
                    />
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold">{template.name}</span>
                      {selected && <span className="text-[10px] font-bold uppercase tracking-wider text-primary">Active</span>}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">{template.description}</span>
                  </button>
                );
              })}
              <p className="pt-1 text-[10px] leading-relaxed text-muted-foreground">
                Switching templates keeps matching business and section content while applying the new layout system.
              </p>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="brief" className="border-border">
            <AccordionTrigger className="hover:no-underline py-2" data-testid="accordion-brief">
              <div className="flex items-center gap-2">
                <Wand2 size={16} className="text-primary" />
                <span>Brief to First Draft</span>
              </div>
            </AccordionTrigger>
            <AccordionContent className="pt-2">
              {!draft ? (
                <div className="space-y-3">
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Turn a short client brief into editable copy across every page. Your layout stays exactly as it is.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="brief-business-type" className="text-xs">Business type</Label>
                      <Input
                        id="brief-business-type"
                        value={brief.businessType}
                        onChange={(event) => updateBrief('businessType', event.target.value)}
                        placeholder="e.g. Interior designer"
                        className="h-8 text-sm"
                        data-testid="input-brief-business-type"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="brief-location" className="text-xs">Location</Label>
                      <Input
                        id="brief-location"
                        value={brief.location}
                        onChange={(event) => updateBrief('location', event.target.value)}
                        placeholder="e.g. Vancouver"
                        className="h-8 text-sm"
                        data-testid="input-brief-location"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="brief-audience" className="text-xs">Audience</Label>
                      <Input
                        id="brief-audience"
                        value={brief.audience}
                        onChange={(event) => updateBrief('audience', event.target.value)}
                        placeholder="e.g. Growing families"
                        className="h-8 text-sm"
                        data-testid="input-brief-audience"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="brief-tone" className="text-xs">Preferred tone</Label>
                      <Select
                        id="brief-tone"
                        value={brief.tone}
                        onChange={(event) => updateBrief('tone', event.target.value as ClientBrief['tone'])}
                        className="h-8 text-sm"
                        data-testid="select-brief-tone"
                      >
                        <option value="professional">Professional</option>
                        <option value="warm">Warm</option>
                        <option value="confident">Confident</option>
                        <option value="friendly">Friendly</option>
                        <option value="refined">Refined</option>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="brief-services" className="text-xs">Services</Label>
                    <Textarea
                      id="brief-services"
                      value={brief.services}
                      onChange={(event) => updateBrief('services', event.target.value)}
                      placeholder="Comma-separated, e.g. Kitchen renovations, custom cabinetry, space planning"
                      rows={2}
                      className="min-h-[60px] text-sm"
                      data-testid="input-brief-services"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="brief-differentiators" className="text-xs">What makes them different?</Label>
                    <Textarea
                      id="brief-differentiators"
                      value={brief.differentiators}
                      onChange={(event) => updateBrief('differentiators', event.target.value)}
                      placeholder="e.g. Owner-led, transparent estimates, and a 15-year local track record"
                      rows={2}
                      className="min-h-[60px] text-sm"
                      data-testid="input-brief-differentiators"
                    />
                  </div>
                  <Button
                    size="sm"
                    className="w-full gap-2"
                    onClick={handleGenerateDraft}
                    data-testid="btn-generate-brief-draft"
                  >
                    <Wand2 size={14} /> Generate draft to review
                  </Button>
                </div>
              ) : (
                <div className="space-y-3" data-testid="brief-draft-review">
                  <div className="rounded-md border border-border bg-muted/30 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-foreground">Review your proposed copy</p>
                        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                          Brief: {draft.brief.businessType} in {draft.brief.location}, for {draft.brief.audience}.
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => {
                          setDraft(null);
                          setDraftSelection(null);
                        }}
                      >
                        Edit brief
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Choose the changes you want to keep. Included changes will apply together; skipped changes stay untouched.
                  </p>
                  <div className="rounded-md border border-border bg-background p-2.5 space-y-2">
                    <p className="text-xs font-semibold text-foreground">Business details</p>
                    {project.business.category !== draft.project.business.category && (
                      <div className={cn(
                        'flex items-center justify-between gap-3 border-b border-border/60 pb-2 text-[11px]',
                        draftSelection?.business.category ? '' : 'opacity-60',
                      )}>
                        <div>
                          <p className="font-medium text-foreground">Category</p>
                          <p className="text-muted-foreground">
                            {project.business.category} <span aria-hidden="true">→</span> {draft.project.business.category}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <span className={cn(
                            'text-[10px] font-semibold',
                            draftSelection?.business.category ? 'text-primary' : 'text-muted-foreground',
                          )}>
                            {draftSelection?.business.category ? 'Included' : 'Skipped'}
                          </span>
                          <Switch
                            checked={draftSelection?.business.category ?? false}
                            onCheckedChange={(included) => setBusinessDraftSelection('category', included)}
                            aria-label="Include category change"
                            data-testid="switch-brief-category"
                          />
                        </div>
                      </div>
                    )}
                    {project.business.city !== draft.project.business.city && (
                      <div className={cn(
                        'flex items-center justify-between gap-3 text-[11px]',
                        draftSelection?.business.location ? '' : 'opacity-60',
                      )}>
                        <div>
                          <p className="font-medium text-foreground">Location</p>
                          <p className="text-muted-foreground">
                            {project.business.city} <span aria-hidden="true">→</span> {draft.project.business.city}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <span className={cn(
                            'text-[10px] font-semibold',
                            draftSelection?.business.location ? 'text-primary' : 'text-muted-foreground',
                          )}>
                            {draftSelection?.business.location ? 'Included' : 'Skipped'}
                          </span>
                          <Switch
                            checked={draftSelection?.business.location ?? false}
                            onCheckedChange={(included) => setBusinessDraftSelection('location', included)}
                            aria-label="Include location change"
                            data-testid="switch-brief-location"
                          />
                        </div>
                      </div>
                    )}
                    {project.business.category === draft.project.business.category
                      && project.business.city === draft.project.business.city && (
                        <p className="text-[11px] text-muted-foreground">No business detail changes proposed.</p>
                      )}
                  </div>
                  <p className="text-[11px] font-medium text-muted-foreground" data-testid="brief-selection-summary">
                    {selectedDraftChangeCount} included · {totalDraftChangeCount - selectedDraftChangeCount} skipped
                  </p>
                  <div className="max-h-80 space-y-3 overflow-y-auto pr-1 custom-scrollbar">
                    {(['home', 'about', 'services', 'contact'] as PageId[]).map((pageId) => {
                      const changedIds = draft.changedSectionIds[pageId];
                      if (!changedIds.length) return null;
                      return (
                        <section key={pageId} className="space-y-2">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {draft.project.pages[pageId].name}
                          </p>
                          {changedIds.map((sectionId) => {
                            const current = project.pages[pageId].sections.find((section) => section.id === sectionId);
                            const proposed = draft.project.pages[pageId].sections.find((section) => section.id === sectionId);
                            return current && proposed ? (
                              <DraftSectionReview
                                key={sectionId}
                                current={current}
                                proposed={proposed}
                                included={draftSelection?.sections[pageId]?.[sectionId] ?? false}
                                onIncludedChange={(included) => setSectionDraftSelection(pageId, sectionId, included)}
                              />
                            ) : null;
                          })}
                        </section>
                      );
                    })}
                  </div>
                  <div className="grid grid-cols-2 gap-2 border-t border-border pt-3">
                    <Button size="sm" variant="outline" onClick={handleGenerateDraft} data-testid="btn-regenerate-brief-draft">
                      Regenerate
                    </Button>
                    <Button
                      size="sm"
                      className="gap-1.5"
                      onClick={handleApplyDraft}
                      disabled={isApplyingDraft || selectedDraftChangeCount === 0}
                      data-testid="btn-apply-brief-draft"
                    >
                      {isApplyingDraft ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                      {isApplyingDraft ? 'Applying…' : `Apply ${selectedDraftChangeCount} change${selectedDraftChangeCount === 1 ? '' : 's'}`}
                    </Button>
                  </div>
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    Included copy stays editable in Page Content. Use Undo to remove all included changes at once.
                  </p>
                </div>
              )}
            </AccordionContent>
          </AccordionItem>
          
          <AccordionItem value="design" className="border-border">
            <AccordionTrigger className="hover:no-underline py-2" data-testid="accordion-design">Design & Branding</AccordionTrigger>
            <AccordionContent className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label>Brand Color</Label>
                <div className="grid grid-cols-4 gap-2">
                  {COLORS.map(c => (
                    <button
                      key={c.value}
                      onClick={() => updateTokens({ primaryColor: c.value })}
                      className={cn(
                        "w-full aspect-square rounded-md border-2 transition-all",
                        project.designTokens.primaryColor === c.value ? "border-primary scale-110 shadow-sm" : "border-transparent hover:scale-105"
                      )}
                      style={{ backgroundColor: c.value }}
                      title={c.name}
                      aria-label={`Use ${c.name} as the brand color`}
                      data-testid={`color-${c.name.toLowerCase()}`}
                    />
                  ))}
                </div>
              </div>

              <div className="space-y-2 pt-2">
                <Label htmlFor="design-font-pair">Typography Pairing</Label>
                <Select
                  id="design-font-pair"
                  value={`${project.designTokens.fontHeading}|${project.designTokens.fontBody}`}
                  onChange={(event) => {
                    const [fontHeading, fontBody] = event.target.value.split('|');
                    updateTokens({ fontHeading, fontBody });
                  }}
                  data-testid="select-font-pair"
                >
                  {FONT_PAIRS.map(pair => (
                    <option key={pair.name} value={`${pair.heading}|${pair.body}`}>{pair.name}</option>
                  ))}
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                <Label htmlFor="design-corner-style">Corner Style</Label>
                <Select 
                  id="design-corner-style"
                  value={project.designTokens.borderRadius} 
                  onChange={(e) => updateTokens({ borderRadius: e.target.value as any })}
                  data-testid="select-radius"
                >
                  <option value="none">Sharp</option>
                  <option value="sm">Subtle</option>
                  <option value="md">Medium</option>
                  <option value="lg">Rounded</option>
                  <option value="full">Pill</option>
                </Select>
              </div>
                <div className="space-y-2">
                  <Label htmlFor="design-button-style">Button Style</Label>
                  <Select
                    id="design-button-style"
                    value={project.designTokens.buttonStyle}
                    onChange={(event) => updateTokens({ buttonStyle: event.target.value as SiteProject['designTokens']['buttonStyle'] })}
                    data-testid="select-button-style"
                  >
                    <option value="solid">Solid</option>
                    <option value="outline">Outline</option>
                    <option value="ghost">Minimal</option>
                  </Select>
                </div>
              </div>

              <div className="space-y-2 pt-2 border-t border-border">
                <Label htmlFor="business-name">Business Name</Label>
                <Input id="business-name" value={project.business.name} onChange={e => updateBusiness({ name: e.target.value })} data-testid="input-biz-name" />
              </div>
              <ImagePicker
                id="business-logo"
                label="Client Logo"
                asset={project.business.logo}
                onChange={(logo) => updateBusiness({ logo })}
                className="aspect-[3/1]"
              />
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Media library: {mediaStats.count}/{MAX_PROJECT_MEDIA_ASSETS} images · {(mediaStats.encodedLength / 1_000_000).toFixed(1)}/{(MAX_PROJECT_MEDIA_DATA_LENGTH / 1_000_000).toFixed(1)} MB optimized
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="business-category">Category</Label>
                  <Input id="business-category" value={project.business.category} onChange={e => updateBusiness({ category: e.target.value })} data-testid="input-biz-category" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="business-city">City / Area</Label>
                  <Input id="business-city" value={project.business.city} onChange={e => updateBusiness({ city: e.target.value })} data-testid="input-biz-city" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="business-phone">Phone</Label>
                  <Input id="business-phone" value={project.business.phone} onChange={e => updateBusiness({ phone: e.target.value })} data-testid="input-biz-phone" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="business-email">Email</Label>
                  <Input id="business-email" type="email" value={project.business.email} onChange={e => updateBusiness({ email: e.target.value })} data-testid="input-biz-email" />
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="content" className="border-border">
            <AccordionTrigger className="hover:no-underline py-2" data-testid="accordion-content">Page Content</AccordionTrigger>
            <AccordionContent className="space-y-4 pt-2">
              {sectionOrder.length === 0 && (
                <div className="text-sm text-muted-foreground text-center py-4">No sections supported on this page for this template.</div>
              )}
              {sectionOrder.map((sectionId, idx) => {
                const section = activePage.sections.find(s => s.id === sectionId);
                if (!section) return null;
                const isHidden = hiddenSections.includes(sectionId);

                return (
                  <div key={sectionId} className={cn("border border-border rounded-lg bg-card overflow-hidden", isHidden && "opacity-60")}>
                    <div className="flex items-center gap-2 p-2 bg-muted/30 border-b border-border">
                      <div className="flex-1 font-medium text-sm flex items-center gap-2">
                        <span className="capitalize">{section.type.replace('-', ' ')}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => toggleSectionVisibility(activePage.id, sectionId)}
                          className="p-1.5 hover:bg-muted rounded text-muted-foreground"
                          aria-label={`${isHidden ? 'Show' : 'Hide'} ${section.type.replace('-', ' ')} section`}
                          data-testid={`btn-toggle-${sectionId}`}
                        >
                          {isHidden ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                        <button onClick={() => moveSection(activePage.id, sectionId, 'up')} disabled={idx === 0} className="p-1.5 hover:bg-muted rounded text-muted-foreground disabled:opacity-30" aria-label={`Move ${section.type.replace('-', ' ')} section up`} data-testid={`btn-section-up-${sectionId}`}>
                          <ArrowUp size={14} />
                        </button>
                        <button onClick={() => moveSection(activePage.id, sectionId, 'down')} disabled={idx === sectionOrder.length - 1} className="p-1.5 hover:bg-muted rounded text-muted-foreground disabled:opacity-30" aria-label={`Move ${section.type.replace('-', ' ')} section down`} data-testid={`btn-section-down-${sectionId}`}>
                          <ArrowDown size={14} />
                        </button>
                      </div>
                    </div>
                    
                    {!isHidden && (
                      <div className="p-3 space-y-3 bg-card">
                        {section.title !== undefined && (
                          <div className="space-y-1">
                            <Label htmlFor={`section-${sectionId}-title`} className="text-xs">Title</Label>
                            <Input id={`section-${sectionId}-title`} value={section.title} onChange={e => updateSection(activePage.id, sectionId, { title: e.target.value })} className="h-8 text-sm" data-testid={`input-section-title-${sectionId}`} />
                          </div>
                        )}
                        {section.subtitle !== undefined && (
                          <div className="space-y-1">
                            <Label htmlFor={`section-${sectionId}-subtitle`} className="text-xs">Subtitle</Label>
                            <Textarea id={`section-${sectionId}-subtitle`} value={section.subtitle} onChange={e => updateSection(activePage.id, sectionId, { subtitle: e.target.value })} rows={2} className="text-sm min-h-[60px]" data-testid={`input-section-subtitle-${sectionId}`} />
                          </div>
                        )}
                        {section.content !== undefined && section.type !== 'hero' && (
                          <div className="space-y-1">
                            <Label htmlFor={`section-${sectionId}-content`} className="text-xs">Content</Label>
                            <Textarea id={`section-${sectionId}-content`} value={section.content} onChange={e => updateSection(activePage.id, sectionId, { content: e.target.value })} rows={4} className="text-sm" data-testid={`input-section-content-${sectionId}`} />
                          </div>
                        )}
                        {section.type === 'hero' && section.content !== undefined && (
                          <div className="space-y-1">
                            <Label htmlFor={`section-${sectionId}-cta`} className="text-xs">Button Text</Label>
                            <Input id={`section-${sectionId}-cta`} value={section.content} onChange={e => updateSection(activePage.id, sectionId, { content: e.target.value })} className="h-8 text-sm" data-testid={`input-section-cta-${sectionId}`} />
                          </div>
                        )}
                        {(section.type === 'hero' || section.type === 'about-text') && (
                          <ImagePicker
                            id={`section-${sectionId}-image`}
                            label={section.type === 'hero' ? 'Hero Image' : 'About Image'}
                            asset={section.image}
                            onChange={(image) => updateSection(activePage.id, sectionId, { image })}
                          />
                        )}
                        
                        {section.items && (
                          <div className="space-y-2 pt-2 border-t border-border">
                            <Label className="text-xs font-semibold">Items ({section.items.length})</Label>
                            {section.items.map((item, itemIdx) => (
                              <div key={itemIdx} className="p-2 border border-border rounded relative bg-muted/10 group">
                                <button 
                                  onClick={() => {
                                    const newItems = [...(section.items || [])];
                                    newItems.splice(itemIdx, 1);
                                    updateSection(activePage.id, sectionId, { items: newItems });
                                  }}
                                  className="absolute top-1 right-1 p-1 rounded hover:bg-destructive hover:text-destructive-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                                  aria-label={`Remove ${item.title}`}
                                  data-testid={`btn-remove-item-${sectionId}-${itemIdx}`}
                                >
                                  <Trash2 size={12} />
                                </button>
                                <Input 
                                  value={item.title} 
                                  onChange={e => {
                                    const newItems = [...(section.items || [])];
                                    newItems[itemIdx] = { ...item, title: e.target.value };
                                    updateSection(activePage.id, sectionId, { items: newItems });
                                  }}
                                  className="h-7 text-xs mb-1 font-medium" 
                                  placeholder="Item Title"
                                  aria-label={`Item ${itemIdx + 1} title`}
                                  data-testid={`input-item-title-${sectionId}-${itemIdx}`}
                                />
                                <Textarea 
                                  value={item.description}
                                  onChange={e => {
                                    const newItems = [...(section.items || [])];
                                    newItems[itemIdx] = { ...item, description: e.target.value };
                                    updateSection(activePage.id, sectionId, { items: newItems });
                                  }}
                                  className="text-xs min-h-[50px] p-1.5"
                                  placeholder="Item Description"
                                  aria-label={`Item ${itemIdx + 1} description`}
                                  data-testid={`input-item-description-${sectionId}-${itemIdx}`}
                                />
                                {(section.type === 'gallery' || section.type === 'team') && (
                                  <div className="mt-2">
                                    <ImagePicker
                                      id={`section-${sectionId}-item-${itemIdx}-image`}
                                      label={section.type === 'gallery' ? 'Gallery Image' : 'Team Photo'}
                                      asset={item.image}
                                      onChange={(image) => {
                                        const newItems = [...(section.items || [])];
                                        newItems[itemIdx] = { ...item, image };
                                        updateSection(activePage.id, sectionId, { items: newItems });
                                      }}
                                      className={section.type === 'team' ? 'aspect-square' : 'aspect-[4/3]'}
                                    />
                                  </div>
                                )}
                              </div>
                            ))}
                            <Button 
                              onClick={() => {
                                const newItems = [...(section.items || []), { title: 'New Item', description: 'Description here.' }];
                                updateSection(activePage.id, sectionId, { items: newItems });
                              }}
                              variant="outline" size="sm" className="w-full gap-1 h-7 text-xs border-dashed"
                              data-testid={`btn-add-item-${sectionId}`}
                            >
                              <Plus size={12} /> Add Item
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="receptionist" className="border-border">
            <AccordionTrigger className="hover:no-underline py-2" data-testid="accordion-receptionist">
              <div className="flex items-center gap-2">
                <Bot size={16} className="text-primary" />
                <span>AI Receptionist</span>
              </div>
            </AccordionTrigger>
            <AccordionContent className="space-y-4 pt-2">
              <div className="flex items-center justify-between bg-muted/30 p-3 rounded-lg border border-border">
                <div className="space-y-0.5">
                  <Label htmlFor="receptionist-enable" className="text-sm font-medium">Enable Chat Widget</Label>
                  <p className="text-xs text-muted-foreground">Add an AI assistant to your site</p>
                </div>
                <Switch 
                  id="receptionist-enable" 
                  checked={project.receptionist?.enabled || false}
                  onCheckedChange={handleToggleReceptionist}
                  disabled={isCreatingReceptionist}
                />
              </div>

              {!project.receptionist?.receptionistId && (
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Your signed-in SiteForge account will securely own this receptionist.
                </p>
              )}

              {project.receptionist?.enabled && (
                <div className="space-y-4 animate-in fade-in slide-in-from-top-2">
                  <div className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
                    <div>
                      <p className="text-sm font-medium">Template starter answers</p>
                      <p className="text-[10px] leading-relaxed text-muted-foreground">
                        Load safe, editable answers for the selected{' '}
                        {TEMPLATES.find(item => item.id === project.templateId)?.name ?? 'business'} template.
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full gap-2"
                      onClick={handleApplyReceptionistStarter}
                      data-testid="btn-apply-receptionist-starter"
                    >
                      <Wand2 size={14} />
                      Apply template starter answers
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rec-assistantName">Assistant Name</Label>
                    <Input 
                      id="rec-assistantName" 
                      value={project.receptionist?.assistantName || ''} 
                      onChange={e => syncSetting('assistantName', e.target.value)} 
                      placeholder="e.g. Sarah"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rec-greeting">Greeting Message</Label>
                    <Textarea 
                      id="rec-greeting" 
                      value={project.receptionist?.greeting || ''} 
                      onChange={e => syncSetting('greeting', e.target.value)} 
                      placeholder="Hi! How can I help you today?"
                      rows={2}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rec-knowledge">Business Knowledge</Label>
                    <Textarea 
                      id="rec-knowledge" 
                      value={project.receptionist?.knowledge || ''} 
                      onChange={e => syncSetting('knowledge', e.target.value)} 
                      placeholder="Describe what your business does, key services, pricing, etc."
                      rows={4}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rec-faqs">Common FAQs</Label>
                    <Textarea 
                      id="rec-faqs" 
                      value={project.receptionist?.faqs || ''} 
                      onChange={e => syncSetting('faqs', e.target.value)} 
                      placeholder="Q: Do you offer free quotes? A: Yes, we do."
                      rows={3}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="rec-hours">Hours</Label>
                      <Input 
                        id="rec-hours" 
                        value={project.receptionist?.hours || ''} 
                        onChange={e => syncSetting('hours', e.target.value)} 
                        placeholder="Mon-Fri 9-5"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="rec-serviceArea">Service Area</Label>
                      <Input 
                        id="rec-serviceArea" 
                        value={project.receptionist?.serviceArea || ''} 
                        onChange={e => syncSetting('serviceArea', e.target.value)} 
                        placeholder="Greater Toronto Area"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rec-escalation">Escalation Contact</Label>
                    <Input 
                      id="rec-escalation" 
                      value={project.receptionist?.escalationContact || ''} 
                      onChange={e => syncSetting('escalationContact', e.target.value)} 
                      placeholder="owner@example.com or phone number"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rec-prohibited">Prohibited Actions</Label>
                    <Textarea 
                      id="rec-prohibited" 
                      value={project.receptionist?.prohibitedActions || ''} 
                      onChange={e => syncSetting('prohibitedActions', e.target.value)} 
                      placeholder="e.g. Pricing; booking; promises; complaints"
                      rows={2}
                    />
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Supported policy groups are enforced server-side. Unrecognized custom rules make the assistant hand off instead of guessing.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="rec-autoreply">Safe Auto-Reply Categories</Label>
                    <Input 
                      id="rec-autoreply" 
                      value={project.receptionist?.safeAutoReplyCategories || ''} 
                      onChange={e => syncSetting('safeAutoReplyCategories', e.target.value)} 
                      placeholder="Hours, Service area, Contact, General services"
                    />
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Strict allowlist: Hours, Service area, Contact, and broad General services overviews. Specific or unrecognized requests are handed to a person.
                    </p>
                  </div>
                  <div className="space-y-2 pt-2 border-t border-border">
                    <Label htmlFor="rec-retell-agent">Retell Agent ID</Label>
                    <Input
                      id="rec-retell-agent"
                      value={project.receptionist?.retellAgentId || ''}
                      readOnly
                      aria-readonly="true"
                    />
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Dedicated transcript source for this pilot. SiteForge does not configure live voice behavior or purchase a phone number.
                    </p>
                  </div>
                  <div className="space-y-2 pt-2 border-t border-border">
                    <Label>Retell Phone Number</Label>
                    {project.receptionist?.retellPhoneNumber ? (
                      <div className="text-sm px-3 py-2 bg-muted/30 border border-border rounded flex items-center gap-2">
                        <PhoneCall size={14} className="text-green-500" />
                        <span className="font-mono text-xs">{project.receptionist.retellPhoneNumber}</span>
                      </div>
                    ) : (
                      <div className="text-xs text-muted-foreground bg-muted/10 p-2 rounded border border-border leading-relaxed">
                        Voice AI is outside the secure pilot. Retell is transcript-sync only, and SiteForge never attaches or purchases a phone number.
                      </div>
                    )}
                  </div>
                  <div className="space-y-2 pt-2 border-t border-border">
                    <Label htmlFor="rec-apiurl">Hosted API URL</Label>
                    <Input 
                      id="rec-apiurl" 
                      value={project.receptionist?.hostedApiUrl || ''} 
                      onChange={e => syncSetting('hostedApiUrl', e.target.value)} 
                      placeholder="Optional in Studio (uses local /api)"
                    />
                    <p className="text-[10px] text-muted-foreground leading-relaxed">
                      Use /api in Studio, or an absolute http:// or https:// URL for an exported site.
                    </p>
                  </div>

                  <Button 
                    className="w-full gap-2 mt-4" 
                    onClick={handleSaveSettings} 
                    disabled={updateSettings.isPending || !project.receptionist?.receptionistId}
                  >
                    {updateSettings.isPending && <Loader2 size={14} className="animate-spin" />}
                    Save Receptionist Settings
                  </Button>
                </div>
              )}
            </AccordionContent>
          </AccordionItem>

        </Accordion>
      </div>
    </div>
  );
}