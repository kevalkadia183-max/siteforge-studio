import {
  BriefDraft,
  BriefDraftSelection,
  ClientBrief,
  HistoryState,
  PageId,
  SectionData,
  SiteProject,
} from './types';

const pageIds: PageId[] = ['home', 'about', 'services', 'contact'];

const clean = (value: string) => value.trim().replace(/\s+/g, ' ');

const sentence = (value: string) => {
  const trimmed = clean(value).replace(/[.!?]+$/, '');
  return trimmed ? `${trimmed}.` : '';
};

const titleCase = (value: string) => clean(value)
  .split(' ')
  .map((word) => word ? `${word[0].toUpperCase()}${word.slice(1)}` : word)
  .join(' ');

const parseServices = (value: string, businessType: string) => {
  const services = value
    .split(/[,;\n]/)
    .map(clean)
    .filter(Boolean)
    .slice(0, 6);

  return services.length ? services : [`${businessType} services`];
};

const listToSentence = (items: string[]) => {
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
};

const toneCopy = {
  warm: {
    lead: 'Thoughtful help, close to home',
    approach: 'A welcoming, straightforward experience from the first conversation onward.',
    cta: 'Start the conversation',
  },
  professional: {
    lead: 'Practical expertise, clearly delivered',
    approach: 'A well-organized experience built around clear communication and dependable next steps.',
    cta: 'Request a consultation',
  },
  confident: {
    lead: 'Capable service with a clear point of view',
    approach: 'Decisive guidance, useful details, and a focused path from question to action.',
    cta: 'Get started',
  },
  friendly: {
    lead: 'Helpful expertise without the runaround',
    approach: 'Easy to reach, easy to understand, and ready to help.',
    cta: 'Talk with our team',
  },
  refined: {
    lead: 'Considered service for discerning clients',
    approach: 'A polished, attentive experience shaped around the details that matter.',
    cta: 'Arrange an introduction',
  },
} as const;

const cloneProject = (project: SiteProject): SiteProject => ({
  ...project,
  business: { ...project.business },
  pages: Object.fromEntries(pageIds.map((pageId) => [
    pageId,
    {
      ...project.pages[pageId],
      sections: project.pages[pageId].sections.map((section) => ({
        ...section,
        items: section.items?.map((item) => ({ ...item })),
      })),
    },
  ])) as SiteProject['pages'],
  sectionOrder: Object.fromEntries(pageIds.map((pageId) => [
    pageId,
    [...project.sectionOrder[pageId]],
  ])) as SiteProject['sectionOrder'],
  hiddenSections: Object.fromEntries(pageIds.map((pageId) => [
    pageId,
    [...project.hiddenSections[pageId]],
  ])) as SiteProject['hiddenSections'],
});

export function createBriefDraftSelection(draft: BriefDraft): BriefDraftSelection {
  return {
    business: {
      category: draft.sourceProject.business.category !== draft.project.business.category,
      location: draft.sourceProject.business.city !== draft.project.business.city,
    },
    sections: Object.fromEntries(pageIds.map((pageId) => [
      pageId,
      Object.fromEntries(draft.changedSectionIds[pageId].map((sectionId) => [sectionId, true])),
    ])) as BriefDraftSelection['sections'],
  };
}

export function getSelectedBriefDraftChangeCount(
  draft: BriefDraft,
  selection: BriefDraftSelection,
): number {
  const selectedBusinessChanges = Number(
    selection.business.category
      && draft.sourceProject.business.category !== draft.project.business.category,
  ) + Number(
    selection.business.location
      && draft.sourceProject.business.city !== draft.project.business.city,
  );

  const selectedSections = pageIds.reduce(
    (total, pageId) => total + draft.changedSectionIds[pageId]
      .filter((sectionId) => selection.sections[pageId]?.[sectionId]).length,
    0,
  );

  return selectedBusinessChanges + selectedSections;
}

/**
 * Keeps the source project intact except for the reviewer's selected changes.
 * The caller can save the returned project as one history entry, so Undo always
 * restores the complete pre-apply site rather than individual draft fragments.
 */
export function buildSelectedBriefDraftProject(
  draft: BriefDraft,
  selection: BriefDraftSelection,
): SiteProject {
  const source = draft.sourceProject;

  return {
    ...source,
    business: {
      ...source.business,
      ...(selection.business.category
        ? { category: draft.project.business.category }
        : {}),
      ...(selection.business.location
        ? { city: draft.project.business.city }
        : {}),
    },
    pages: Object.fromEntries(pageIds.map((pageId) => {
      const selectedSectionIds = selection.sections[pageId] || {};
      const proposedSectionsById = new Map(
        draft.project.pages[pageId].sections.map((section) => [section.id, section]),
      );

      return [
        pageId,
        {
          ...source.pages[pageId],
          sections: source.pages[pageId].sections.map((section) => (
            selectedSectionIds[section.id]
              ? proposedSectionsById.get(section.id) || section
              : section
          )),
        },
      ];
    })) as SiteProject['pages'],
  };
}

export function applySelectedBriefDraftToHistory(
  current: HistoryState | null,
  draft: BriefDraft,
  selection: BriefDraftSelection,
  updatedAt: number,
): { applied: boolean; history: HistoryState | null } {
  if (!current || current.present !== draft.sourceProject) {
    return { applied: false, history: current };
  }

  const next: SiteProject = {
    ...buildSelectedBriefDraftProject(draft, selection),
    updatedAt,
  };

  return {
    applied: true,
    history: {
      past: [...current.past, current.present].slice(-50),
      present: next,
      future: [],
    },
  };
}

const updateSection = (
  project: SiteProject,
  changedSectionIds: Record<PageId, string[]>,
  pageId: PageId,
  sectionType: SectionData['type'],
  updates: Partial<SectionData>,
) => {
  const section = project.pages[pageId].sections.find((candidate) => candidate.type === sectionType);
  if (!section) return;

  Object.assign(section, updates);
  changedSectionIds[pageId].push(section.id);
};

/**
 * Makes a complete content proposal without changing template structure.
 * Existing sections remain in place so the normal structured controls stay authoritative.
 */
export function createBriefDraft(project: SiteProject, brief: ClientBrief): BriefDraft {
  const draft = cloneProject(project);
  const businessType = clean(brief.businessType) || project.business.category || 'Local service';
  const location = clean(brief.location) || project.business.city || 'your area';
  const audience = clean(brief.audience) || 'local clients';
  const differentiator = sentence(brief.differentiators) || 'Clear communication and thoughtful service are at the center of every engagement.';
  const services = parseServices(brief.services, businessType);
  const servicesText = listToSentence(services);
  const voice = toneCopy[brief.tone];
  const name = clean(project.business.name) || 'Our team';
  const changedSectionIds: Record<PageId, string[]> = { home: [], about: [], services: [], contact: [] };

  draft.business.category = businessType;
  draft.business.city = location;

  updateSection(draft, changedSectionIds, 'home', 'hero', {
    title: `${voice.lead} for ${audience}`,
    subtitle: `${name} provides ${servicesText} in ${location}. ${differentiator}`,
    content: voice.cta,
  });
  updateSection(draft, changedSectionIds, 'home', 'features', {
    title: `Why ${audience} choose ${name}`,
    items: [
      { title: 'Made for your needs', description: `Focused ${businessType.toLowerCase()} support shaped around what matters to ${audience}.` },
      { title: 'Clear from the start', description: voice.approach },
      { title: 'A local perspective', description: `Rooted in ${location} and attentive to the details behind every request.` },
    ],
  });
  updateSection(draft, changedSectionIds, 'home', 'services-list', {
    title: `Services for ${audience}`,
    subtitle: `Explore ${businessType.toLowerCase()} support from ${name} in ${location}.`,
    items: services.map((service) => ({
      title: titleCase(service),
      description: `Thoughtful ${service.toLowerCase()} tailored to the priorities of ${audience}.`,
    })),
  });
  updateSection(draft, changedSectionIds, 'home', 'about-text', {
    title: `Meet ${name}`,
    content: `${name} is a ${businessType.toLowerCase()} business serving ${audience} in ${location}. We bring together ${servicesText} with an approach that feels ${brief.tone}. ${differentiator}`,
  });
  updateSection(draft, changedSectionIds, 'home', 'testimonials', {
    title: 'What you can expect',
    items: [
      { title: 'A clear process', description: 'Know what happens next, who is involved, and how to get answers along the way.' },
      { title: 'Attention to detail', description: differentiator },
    ],
  });
  updateSection(draft, changedSectionIds, 'home', 'gallery', {
    title: `${name} at work`,
    items: services.slice(0, 4).map((service) => ({
      title: titleCase(service),
      description: `A closer look at how we support ${audience}.`,
    })),
  });
  updateSection(draft, changedSectionIds, 'home', 'contact-form', {
    title: 'Let’s talk about what you need',
    subtitle: `Tell us a little about your goals, and our ${businessType.toLowerCase()} team will be in touch.`,
  });

  updateSection(draft, changedSectionIds, 'about', 'about-text', {
    title: `A ${businessType.toLowerCase()} business built around people`,
    content: `${name} serves ${audience} throughout ${location}. Our work centers on ${servicesText}, with a ${brief.tone} approach to every conversation. ${differentiator}`,
  });
  updateSection(draft, changedSectionIds, 'about', 'team', {
    title: 'A team you can talk to',
    items: [
      { title: 'Our approach', description: voice.approach },
      { title: 'What guides us', description: differentiator },
    ],
  });
  updateSection(draft, changedSectionIds, 'about', 'gallery', {
    title: 'The details behind our work',
    items: services.slice(0, 4).map((service) => ({
      title: titleCase(service),
      description: `Careful work for ${audience} in ${location}.`,
    })),
  });

  updateSection(draft, changedSectionIds, 'services', 'services-list', {
    title: `How we help ${audience}`,
    subtitle: `${name} offers ${servicesText} across ${location}.`,
    items: services.map((service) => ({
      title: titleCase(service),
      description: `A clear, considered ${service.toLowerCase()} experience designed around your needs.`,
    })),
  });
  updateSection(draft, changedSectionIds, 'services', 'features', {
    title: 'Service with intention',
    items: [
      { title: 'Focused expertise', description: `Support grounded in the practical details of ${businessType.toLowerCase()}.` },
      { title: 'Simple next steps', description: 'Straightforward information so you can move ahead with confidence.' },
      { title: 'The right fit', description: `A collaborative approach for ${audience}, not one-size-fits-all answers.` },
    ],
  });
  updateSection(draft, changedSectionIds, 'services', 'faq', {
    title: 'Questions, answered',
    items: [
      { title: 'What services do you offer?', description: `${name} provides ${servicesText}.` },
      { title: `Do you serve ${location}?`, description: `Yes. We work with ${audience} throughout ${location}.` },
      { title: 'How do I get started?', description: `Send us a message with what you need, and we’ll help you find the right next step.` },
    ],
  });
  updateSection(draft, changedSectionIds, 'services', 'contact-form', {
    title: `Find the right ${businessType.toLowerCase()} support`,
    subtitle: `Share a few details and we’ll point you toward the best next step.`,
  });

  updateSection(draft, changedSectionIds, 'contact', 'contact-form', {
    title: 'Start the conversation',
    subtitle: `Reach out to ${name} for ${servicesText} in ${location}.`,
  });
  updateSection(draft, changedSectionIds, 'contact', 'faq', {
    title: 'Before you reach out',
    items: [
      { title: 'Who do you work with?', description: `We support ${audience} in ${location}.` },
      { title: 'What should I include in my message?', description: 'Tell us what you need, where you are, and any timing or priorities that matter.' },
      { title: 'What happens next?', description: 'We’ll review your message and follow up with a clear next step.' },
    ],
  });

  return {
    brief: { ...brief, businessType, location },
    project: draft,
    sourceProject: project,
    changedSectionIds,
  };
}