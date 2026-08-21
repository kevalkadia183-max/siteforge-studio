export type PageId = 'home' | 'about' | 'services' | 'contact';

export type TemplateId =
  | 'home-services'
  | 'advisor'
  | 'cafe'
  | 'wellness'
  | 'creative'
  | 'plumber'
  | 'electrician'
  | 'carpenter';

export type DesignTokens = {
  primaryColor: string;
  fontHeading: string;
  fontBody: string;
  borderRadius: 'none' | 'sm' | 'md' | 'lg' | 'full';
  buttonStyle: 'solid' | 'outline' | 'ghost';
};

export type BusinessInfo = {
  name: string;
  category: string;
  city: string;
  phone: string;
  email: string;
  logo?: MediaAsset;
  socialLinks?: { type: string; url: string }[];
};

export type BriefTone = 'warm' | 'professional' | 'confident' | 'friendly' | 'refined';

export type ClientBrief = {
  businessType: string;
  services: string;
  location: string;
  audience: string;
  differentiators: string;
  tone: BriefTone;
};

export type MediaAsset = {
  id: string;
  name: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'image/avif';
  dataUrl: string;
};

export type SectionType =
  | 'hero'
  | 'features'
  | 'services-list'
  | 'about-text'
  | 'testimonials'
  | 'contact-form'
  | 'gallery'
  | 'faq'
  | 'stats'
  | 'team';

export type SectionData = {
  id: string;
  type: SectionType;
  title?: string;
  subtitle?: string;
  content?: string;
  image?: MediaAsset;
  items?: Array<{ title: string; description: string; image?: MediaAsset }>;
};

export type PageData = {
  id: PageId;
  name: string;
  sections: SectionData[];
};

export type ReceptionistConfig = {
  enabled: boolean;
  receptionistId?: string;
  ownerKey?: string;
  hostedApiUrl?: string;
  assistantName: string;
  greeting?: string;
  knowledge?: string;
  faqs?: string;
  hours?: string;
  serviceArea?: string;
  escalationContact?: string;
  prohibitedActions?: string;
  safeAutoReplyCategories?: string;
  retellAgentId?: string;
  retellPhoneNumber?: string;
  provisionedAt?: number;
  updatedAt?: number;
};

/**
 * Optional metadata attached to SiteProject when generated as a prospect draft.
 * Never present on normal customer projects.  The presence of this field with
 * isDraft=true is the authoritative signal that a site is prospect-safe.
 */
export type ProspectMeta = {
  isDraft: true;
  leadId: string;
  generationId: string;
};

export type SiteProject = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  activePageId: PageId;
  templateId: TemplateId;
  designTokens: DesignTokens;
  business: BusinessInfo;
  pages: Record<PageId, PageData>;
  sectionOrder: Record<PageId, string[]>; // Ordered section IDs per page
  hiddenSections: Record<PageId, string[]>;
  receptionist?: ReceptionistConfig;
  /** Present only on prospect draft projects; absent on all customer projects. */
  prospectMeta?: ProspectMeta;
};

export type BriefDraft = {
  brief: ClientBrief;
  project: SiteProject;
  sourceProject: SiteProject;
  changedSectionIds: Record<PageId, string[]>;
};

export type BriefDraftSelection = {
  business: {
    category: boolean;
    location: boolean;
  };
  sections: Record<PageId, Record<string, boolean>>;
};

export type HistoryState = {
  past: SiteProject[];
  present: SiteProject;
  future: SiteProject[];
};

export type TemplateMeta = {
  id: TemplateId;
  name: string;
  description: string;
  defaultTokens: DesignTokens;
  supportedPages: PageId[];
  supportedSections: Record<PageId, SectionType[]>;
};
