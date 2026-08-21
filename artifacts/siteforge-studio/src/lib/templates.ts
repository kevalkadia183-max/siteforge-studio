import {
  TemplateMeta,
  SiteProject,
  PageData,
  SectionData,
  PageId,
  SectionType,
  TemplateId,
  BusinessInfo,
  ReceptionistConfig,
} from './types';

export const TEMPLATES: TemplateMeta[] = [
  {
    id: 'home-services',
    name: 'Home Services',
    description: 'Bold and clear for trades, cleaners, and landscapers.',
    defaultTokens: {
      primaryColor: '#ef5d3f', // Coral
      fontHeading: 'Manrope',
      fontBody: 'Inter',
      borderRadius: 'lg',
      buttonStyle: 'solid'
    },
    supportedPages: ['home', 'about', 'services', 'contact'],
    supportedSections: {
      home: ['hero', 'features', 'services-list', 'testimonials', 'contact-form'],
      services: ['services-list', 'faq', 'contact-form'],
      contact: ['contact-form', 'faq'],
      about: ['about-text', 'team']
    }
  },
  {
    id: 'advisor',
    name: 'Advisor',
    description: 'Clean and professional for consultants and accountants.',
    defaultTokens: {
      primaryColor: '#1e3a8a', // Navy
      fontHeading: 'Playfair Display',
      fontBody: 'Inter',
      borderRadius: 'sm',
      buttonStyle: 'solid'
    },
    supportedPages: ['home', 'about', 'services', 'contact'],
    supportedSections: {
      home: ['hero', 'features', 'about-text', 'contact-form'],
      about: ['about-text', 'team'],
      services: ['services-list', 'features'],
      contact: ['contact-form']
    }
  },
  {
    id: 'cafe',
    name: 'Cafe & Restaurant',
    description: 'Warm and inviting for local food businesses.',
    defaultTokens: {
      primaryColor: '#d97706', // Amber
      fontHeading: 'Fraunces',
      fontBody: 'DM Sans',
      borderRadius: 'md',
      buttonStyle: 'outline'
    },
    supportedPages: ['home', 'about', 'services', 'contact'],
    supportedSections: {
      home: ['hero', 'gallery', 'about-text', 'contact-form'],
      about: ['about-text', 'gallery'],
      services: ['services-list', 'faq'],
      contact: ['contact-form']
    }
  },
  {
    id: 'wellness',
    name: 'Wellness Clinic',
    description: 'Calm and reassuring for health and therapy clinics.',
    defaultTokens: {
      primaryColor: '#059669', // Emerald
      fontHeading: 'Outfit',
      fontBody: 'Outfit',
      borderRadius: 'full',
      buttonStyle: 'solid'
    },
    supportedPages: ['home', 'services', 'about', 'contact'],
    supportedSections: {
      home: ['hero', 'features', 'testimonials', 'contact-form'],
      about: ['about-text', 'team', 'gallery'],
      services: ['services-list', 'faq'],
      contact: ['contact-form']
    }
  },
  {
    id: 'creative',
    name: 'Creative Studio',
    description: 'Minimal and striking for agencies and real estate.',
    defaultTokens: {
      primaryColor: '#171717', // Dark Gray
      fontHeading: 'Space Mono',
      fontBody: 'Inter',
      borderRadius: 'none',
      buttonStyle: 'solid'
    },
    supportedPages: ['home', 'about', 'services', 'contact'],
    supportedSections: {
      home: ['hero', 'gallery', 'features', 'contact-form'],
      about: ['about-text', 'team'],
      services: ['services-list', 'features'],
      contact: ['contact-form']
    }
  },
  {
    id: 'plumber',
    name: 'Plumber',
    description: 'Clear, dependable service for repairs, installs, and emergencies.',
    defaultTokens: {
      primaryColor: '#0f6cbd',
      fontHeading: 'Manrope',
      fontBody: 'Inter',
      borderRadius: 'md',
      buttonStyle: 'solid'
    },
    supportedPages: ['home', 'about', 'services', 'contact'],
    supportedSections: {
      home: ['hero', 'features', 'services-list', 'testimonials', 'contact-form'],
      about: ['about-text', 'team'],
      services: ['services-list', 'faq', 'contact-form'],
      contact: ['contact-form', 'faq']
    }
  },
  {
    id: 'electrician',
    name: 'Electrician',
    description: 'High-contrast and trusted for residential and commercial electrical work.',
    defaultTokens: {
      primaryColor: '#f59e0b',
      fontHeading: 'Outfit',
      fontBody: 'Inter',
      borderRadius: 'sm',
      buttonStyle: 'solid'
    },
    supportedPages: ['home', 'about', 'services', 'contact'],
    supportedSections: {
      home: ['hero', 'features', 'services-list', 'stats', 'contact-form'],
      about: ['about-text', 'team'],
      services: ['services-list', 'faq', 'contact-form'],
      contact: ['contact-form', 'faq']
    }
  },
  {
    id: 'carpenter',
    name: 'Carpenter',
    description: 'Warm, crafted presentation for custom woodwork and renovations.',
    defaultTokens: {
      primaryColor: '#8b5e3c',
      fontHeading: 'Fraunces',
      fontBody: 'DM Sans',
      borderRadius: 'sm',
      buttonStyle: 'solid'
    },
    supportedPages: ['home', 'about', 'services', 'contact'],
    supportedSections: {
      home: ['hero', 'gallery', 'features', 'testimonials', 'contact-form'],
      about: ['about-text', 'gallery'],
      services: ['services-list', 'gallery', 'faq'],
      contact: ['contact-form']
    }
  }
];

type ReceptionistStarterCopy = {
  knowledge: string;
  faqs: string;
  hours: string;
};

const RECEPTIONIST_STARTER_COPY: Record<TemplateId, ReceptionistStarterCopy> = {
  'home-services': {
    knowledge: 'We provide local home maintenance, cleaning, landscaping, and general property care services.',
    faqs: 'Q: What services do you offer? A: We help with common home maintenance, cleaning, landscaping, and property care needs.',
    hours: 'Monday to Friday, 9:00 AM to 5:00 PM.',
  },
  advisor: {
    knowledge: 'We provide business advisory, strategic planning, and practical guidance for owner-led companies.',
    faqs: 'Q: What services do you offer? A: We help business owners with strategy, planning, and general advisory support.',
    hours: 'Monday to Friday, 9:00 AM to 5:00 PM.',
  },
  cafe: {
    knowledge: 'We offer coffee, seasonal food, and a welcoming place for casual dining.',
    faqs: 'Q: What do you offer? A: We serve coffee, seasonal dishes, and a changing selection of cafe favourites.',
    hours: 'Monday to Sunday, 8:00 AM to 6:00 PM.',
  },
  wellness: {
    knowledge: 'We offer general wellness consultations and practitioner-led support in a calm clinic setting.',
    faqs: 'Q: What services do you offer? A: We provide general wellness consultations and practitioner-led support. Personal care questions are referred to the clinic team.',
    hours: 'Monday to Friday, 9:00 AM to 5:00 PM.',
  },
  creative: {
    knowledge: 'We provide brand strategy, visual identity, website design, and digital creative services.',
    faqs: 'Q: What services do you offer? A: We help with brand strategy, identity design, websites, and digital creative work.',
    hours: 'Monday to Friday, 9:00 AM to 5:00 PM.',
  },
  plumber: {
    knowledge: 'We provide leak repairs, drain clearing, fixture installation, and general plumbing maintenance.',
    faqs: 'Q: What plumbing services do you offer? A: We help with leaks, blocked drains, fixture installation, and general plumbing maintenance.',
    hours: 'Monday to Saturday, 8:00 AM to 6:00 PM.',
  },
  electrician: {
    knowledge: 'We provide electrical troubleshooting, lighting and fixture installation, panel work, and renovation electrical support.',
    faqs: 'Q: What electrical services do you offer? A: We help with troubleshooting, lighting, fixtures, panels, and renovation electrical work.',
    hours: 'Monday to Saturday, 8:00 AM to 6:00 PM.',
  },
  carpenter: {
    knowledge: 'We provide custom built-ins, finish carpentry, trim work, and renovation woodwork.',
    faqs: 'Q: What carpentry services do you offer? A: We create custom built-ins, finish carpentry, trim, and renovation woodwork.',
    hours: 'Monday to Saturday, 8:00 AM to 6:00 PM.',
  },
};

const DEFAULT_PROHIBITED_ACTIONS =
  'Pricing; payments and refunds; booking and scheduling; promises and guarantees; legal matters; medical matters; complaints';
const DEFAULT_SAFE_AUTO_REPLY_CATEGORIES =
  'Hours, Service area, Contact, General services';

type TemplateDemoContent = {
  business: Omit<BusinessInfo, 'logo' | 'socialLinks' | 'name'> & { name: string };
  tagline: string;
  services: Array<{ title: string; description: string }>;
  faqs: Array<{ title: string; description: string }>;
  testimonials: Array<{ title: string; description: string }>;
  gallery: Array<{ title: string; description: string }>;
  team: Array<{ title: string; description: string }>;
};

const TEMPLATE_DEMO_CONTENT: Record<TemplateId, TemplateDemoContent> = {
  'home-services': {
    business: { name: 'Northline Home Co.', category: 'Home Services', city: 'Toronto', phone: '(416) 555-0142', email: 'hello@northlinehome.example' },
    tagline: 'Local home care with clear communication and thoughtful results.',
    services: [
      { title: 'Home maintenance', description: 'Seasonal checkups and practical repairs that keep your home running smoothly.' },
      { title: 'Cleaning & care', description: 'Careful indoor and exterior cleaning for a refreshed, well-kept property.' },
      { title: 'Outdoor upkeep', description: 'Reliable property care for the spaces around your home.' },
    ],
    faqs: [
      { title: 'What areas do you serve?', description: 'This demo business serves Toronto and nearby neighbourhoods. Update this with your own service area.' },
      { title: 'How do I request help?', description: 'Send a message with a short description of the work and the team will follow up.' },
    ],
    testimonials: [
      { title: 'Maya R. · Leslieville', description: 'Clear updates, thoughtful work, and everything was left spotless.' },
      { title: 'Daniel K. · High Park', description: 'The whole process was easy from the first message to the final walk-through.' },
    ],
    gallery: [
      { title: 'Seasonal exterior refresh', description: 'A carefully prepared home ready for the new season.' },
      { title: 'Entryway update', description: 'Small maintenance details that make a noticeable difference.' },
      { title: 'Garden-side care', description: 'Respectful work around the outdoor spaces clients enjoy most.' },
    ],
    team: [{ title: 'Jordan Lee', description: 'Owner & Home Care Specialist' }],
  },
  advisor: {
    business: { name: 'Northstar Advisory', category: 'Business Advisory', city: 'Toronto', phone: '(416) 555-0168', email: 'hello@northstaradvisory.example' },
    tagline: 'Clear thinking and practical guidance for owner-led businesses.',
    services: [
      { title: 'Strategic planning', description: 'Turn your next quarter or year into a focused, measurable plan.' },
      { title: 'Financial clarity', description: 'Understand the numbers that matter and the decisions behind them.' },
      { title: 'Growth advisory', description: 'Practical counsel for teams navigating a new opportunity or challenge.' },
    ],
    faqs: [
      { title: 'Who do you work with?', description: 'This demo is written for owner-led companies. Edit this answer to reflect your ideal clients.' },
      { title: 'What happens in a first conversation?', description: 'We learn about your goals, current priorities, and whether there is a useful next step.' },
    ],
    testimonials: [
      { title: 'Amelia T. · Founder', description: 'We left with a practical plan and far more confidence about our next move.' },
      { title: 'Raj P. · Managing Director', description: 'Thoughtful advice, direct communication, and no unnecessary complexity.' },
    ],
    gallery: [
      { title: 'Growth plan workshop', description: 'A collaborative working session that turns ideas into priorities.' },
      { title: 'Leadership review', description: 'A clear view of the metrics and decisions that shape progress.' },
      { title: 'Quarterly roadmap', description: 'A practical framework for the work ahead.' },
    ],
    team: [{ title: 'Avery Morgan', description: 'Principal Advisor' }],
  },
  cafe: {
    business: { name: 'Cedar & Steam Café', category: 'Cafe & Kitchen', city: 'Toronto', phone: '(416) 555-0117', email: 'hello@cedarandsteam.example' },
    tagline: 'Seasonal plates, proper coffee, and a table worth returning to.',
    services: [
      { title: 'Specialty coffee', description: 'Thoughtfully prepared espresso, filter coffee, and house-made seasonal drinks.' },
      { title: 'All-day kitchen', description: 'Comforting breakfast and lunch plates made with seasonal ingredients.' },
      { title: 'Private gatherings', description: 'A warm setting for small celebrations, team lunches, and community events.' },
    ],
    faqs: [
      { title: 'Do you take reservations?', description: 'Update this answer with your booking policy, walk-in details, or reservation link.' },
      { title: 'Do you have dietary options?', description: 'Share the dietary options your kitchen can accommodate and invite guests to ask the team for details.' },
    ],
    testimonials: [
      { title: 'Nora C. · Neighbour', description: 'My favourite place for a slow morning coffee and a really good breakfast.' },
      { title: 'Theo W. · Local regular', description: 'Warm service, beautiful food, and the room always feels welcoming.' },
    ],
    gallery: [
      { title: 'Morning coffee ritual', description: 'Signature drinks made with care at the bar.' },
      { title: 'Seasonal brunch', description: 'A bright, generous plate built around local ingredients.' },
      { title: 'The dining room', description: 'A relaxed neighbourhood space for good food and conversation.' },
    ],
    team: [{ title: 'Camille Roy', description: 'Chef & Co-owner' }],
  },
  wellness: {
    business: { name: 'Haven Wellness Clinic', category: 'Wellness Clinic', city: 'Toronto', phone: '(416) 555-0191', email: 'hello@havenwellness.example' },
    tagline: 'A calm, collaborative place for sustainable wellbeing.',
    services: [
      { title: 'Wellness consultations', description: 'A thoughtful first conversation focused on your goals and the support you are seeking.' },
      { title: 'Practitioner support', description: 'Ongoing, practitioner-led care in a calm and welcoming clinic setting.' },
      { title: 'Workshops & resources', description: 'Practical tools and group learning for everyday wellbeing.' },
    ],
    faqs: [
      { title: 'What should I expect at a first visit?', description: 'Update this with your intake process, appointment length, and any preparation details.' },
      { title: 'How do I choose a practitioner?', description: 'Share how clients can find the right service or practitioner for their goals.' },
    ],
    testimonials: [
      { title: 'Erin L. · Client', description: 'The clinic felt calm from the first visit, and every step was clearly explained.' },
      { title: 'Sam P. · Client', description: 'Thoughtful people, practical support, and a pace that felt right for me.' },
    ],
    gallery: [
      { title: 'A calm welcome', description: 'A warm, uncluttered environment designed for comfortable visits.' },
      { title: 'Thoughtful resources', description: 'Practical tools that help clients carry their progress into daily life.' },
      { title: 'Practitioner care', description: 'A collaborative approach shaped around each client.' },
    ],
    team: [{ title: 'Dr. Morgan Ellis', description: 'Clinic Director' }],
  },
  creative: {
    business: { name: 'Signal & Story Studio', category: 'Creative Studio', city: 'Toronto', phone: '(416) 555-0129', email: 'hello@signalandstory.example' },
    tagline: 'Strategy, identity, and digital work for ambitious teams.',
    services: [
      { title: 'Brand strategy', description: 'Positioning, audience insight, and a sharper story for your market.' },
      { title: 'Visual identity', description: 'A flexible design system that brings your brand to life everywhere it appears.' },
      { title: 'Web experiences', description: 'Useful, conversion-minded websites with a distinct point of view.' },
    ],
    faqs: [
      { title: 'What types of projects do you take on?', description: 'Use this space to describe the clients, scopes, and timelines that are a good fit.' },
      { title: 'How does a project begin?', description: 'Explain your discovery process and what a new client can expect in the first weeks.' },
    ],
    testimonials: [
      { title: 'Lina C. · Marketing Lead', description: 'They gave us a point of view we could use, not just a polished logo.' },
      { title: 'Marcus V. · Founder', description: 'The new site feels unmistakably ours and works harder for the business.' },
    ],
    gallery: [
      { title: 'Brand system for a growing team', description: 'A flexible identity made to work across product, print, and digital.' },
      { title: 'Editorial website launch', description: 'A clear digital home built around a strong point of view.' },
      { title: 'Campaign toolkit', description: 'A cohesive visual language designed for quick, confident rollout.' },
    ],
    team: [{ title: 'Quinn Patel', description: 'Creative Director' }],
  },
  plumber: {
    business: { name: 'ClearFlow Plumbing Co.', category: 'Plumbing Services', city: 'Toronto', phone: '(416) 555-0136', email: 'hello@clearflowplumbing.example' },
    tagline: 'Straightforward plumbing help, careful work, and clear communication.',
    services: [
      { title: 'Leak & fixture repairs', description: 'Practical repairs for leaking taps, toilets, fixtures, and everyday plumbing issues.' },
      { title: 'Drain clearing', description: 'Help with blocked sinks, tubs, showers, and common household drains.' },
      { title: 'Installations & upgrades', description: 'Careful fixture and plumbing updates for kitchens, bathrooms, and laundry rooms.' },
    ],
    faqs: [
      { title: 'What plumbing work do you handle?', description: 'List the repair, installation, and maintenance work your team provides.' },
      { title: 'What should I do before you arrive?', description: 'Add any simple preparation steps you recommend for clients.' },
    ],
    testimonials: [
      { title: 'Kim S. · Riverdale', description: 'They explained the issue plainly, arrived when they said they would, and left everything tidy.' },
      { title: 'Owen M. · The Junction', description: 'Professional from first call to final check. Exactly what we needed.' },
    ],
    gallery: [
      { title: 'Kitchen fixture refresh', description: 'A clean, functional update for a hardworking family kitchen.' },
      { title: 'Bathroom repair', description: 'Careful problem-solving and a tidy finish in a compact space.' },
      { title: 'Laundry room upgrade', description: 'Practical plumbing improvements built around everyday use.' },
    ],
    team: [{ title: 'Casey Morgan', description: 'Owner & Lead Plumber' }],
  },
  electrician: {
    business: { name: 'Brightline Electric', category: 'Electrical Services', city: 'Toronto', phone: '(416) 555-0176', email: 'hello@brightlineelectric.example' },
    tagline: 'Safe, precise electrical work for the spaces that matter.',
    services: [
      { title: 'Troubleshooting & repairs', description: 'Thoughtful help identifying and resolving common electrical concerns.' },
      { title: 'Lighting & fixtures', description: 'Purposeful indoor, outdoor, and workspace lighting upgrades.' },
      { title: 'Panels & renovations', description: 'Electrical planning and upgrades for evolving homes and businesses.' },
    ],
    faqs: [
      { title: 'What kinds of electrical work do you handle?', description: 'Describe the residential, commercial, repair, or renovation work your team is qualified to do.' },
      { title: 'How do I prepare for an assessment?', description: 'Share any helpful details clients can gather before a visit.' },
    ],
    testimonials: [
      { title: 'Priya N. · East York', description: 'Careful, respectful work and clear explanations at every step.' },
      { title: 'Alex G. · Liberty Village', description: 'The lighting update made a huge difference and the job site was spotless.' },
    ],
    gallery: [
      { title: 'Kitchen lighting plan', description: 'Layered lighting that makes a busy room more useful and inviting.' },
      { title: 'Workspace upgrade', description: 'Clean fixture installation designed around the way the room is used.' },
      { title: 'Exterior lighting', description: 'Practical illumination that improves visibility around the home.' },
    ],
    team: [{ title: 'Riley Chen', description: 'Owner & Master Electrician' }],
  },
  carpenter: {
    business: { name: 'Hearthwood Carpentry', category: 'Carpentry & Woodwork', city: 'Toronto', phone: '(416) 555-0154', email: 'hello@hearthwoodcarpentry.example' },
    tagline: 'Custom woodwork and durable details made for everyday life.',
    services: [
      { title: 'Custom built-ins', description: 'Storage and display pieces designed around your room and routines.' },
      { title: 'Finish carpentry', description: 'Trim, millwork, and careful details that make a space feel complete.' },
      { title: 'Renovation woodwork', description: 'Thoughtful carpentry for kitchens, living spaces, and commercial interiors.' },
    ],
    faqs: [
      { title: 'What types of projects do you take on?', description: 'Describe the rooms, project sizes, and woodwork specialties that are a good fit.' },
      { title: 'How does a custom project start?', description: 'Share your process for measurements, materials, drawings, and scheduling.' },
    ],
    testimonials: [
      { title: 'Naomi B. · Bloor West', description: 'Beautiful work, thoughtful ideas, and every detail feels intentional.' },
      { title: 'Jamie R. · Roncesvalles', description: 'The built-ins changed how we use the room every day.' },
    ],
    gallery: [
      { title: 'Living room built-ins', description: 'Custom storage and display designed to feel like part of the home.' },
      { title: 'Kitchen millwork', description: 'Warm wood details that bring character to a hardworking space.' },
      { title: 'Entryway storage', description: 'A tailored solution for the things a busy household needs close at hand.' },
    ],
    team: [{ title: 'Rowan Ellis', description: 'Owner & Lead Carpenter' }],
  },
};

export function getDefaultBusinessName(templateId: TemplateId): string {
  return TEMPLATE_DEMO_CONTENT[templateId].business.name;
}

export function createReceptionistStarter(
  templateId: TemplateId,
  business: BusinessInfo,
): ReceptionistConfig {
  const copy = RECEPTIONIST_STARTER_COPY[templateId];
  const businessName = business.name.trim() || 'our business';
  const city = business.city.trim() || 'the local area';
  return {
    enabled: false,
    assistantName: 'Assistant',
    greeting: `Hi! Thanks for contacting ${businessName}. I can help with basic questions about our services, hours, service area, and contact information.`,
    knowledge: `${businessName} serves customers in ${city}. ${copy.knowledge}`,
    faqs: copy.faqs,
    hours: copy.hours,
    serviceArea: `${city} and nearby areas.`,
    escalationContact: business.phone.trim() || business.email.trim(),
    prohibitedActions: DEFAULT_PROHIBITED_ACTIONS,
    safeAutoReplyCategories: DEFAULT_SAFE_AUTO_REPLY_CATEGORIES,
  };
}

const generateId = () => Math.random().toString(36).substring(2, 9);

export function createDefaultSection(type: SectionType): SectionData {
  const id = generateId();
  switch (type) {
    case 'hero':
      return { id, type, title: 'A better first impression.', subtitle: 'Professional service, made simple.', content: 'Get in touch' };
    case 'features':
      return { id, type, title: 'Why choose us', items: [{ title: 'Reliable', description: 'We show up on time.' }, { title: 'Expert', description: 'Years of experience.' }] };
    case 'services-list':
      return { id, type, title: 'Our Services', items: [{ title: 'Service 1', description: 'Description of service 1.' }] };
    case 'about-text':
      return { id, type, title: 'About Us', content: 'We are a local business dedicated to our community.' };
    case 'testimonials':
      return { id, type, title: 'Client Reviews', items: [{ title: 'Great job!', description: 'Highly recommend.' }] };
    case 'contact-form':
      return { id, type, title: 'Contact Us', subtitle: 'Reach out for a quote.' };
    case 'gallery':
      return { id, type, title: 'Our Work', items: [] };
    case 'faq':
      return { id, type, title: 'Frequently Asked Questions', items: [{ title: 'Question 1?', description: 'Answer 1.' }] };
    case 'stats':
      return { id, type, title: 'By the numbers', items: [{ title: '100+', description: 'Happy clients' }] };
    case 'team':
      return { id, type, title: 'Our Team', items: [{ title: 'Jane Doe', description: 'Founder' }] };
    default:
      return { id, type };
  }
}

function copyDemoItems(items: Array<{ title: string; description: string }>) {
  return items.map((item) => ({ ...item }));
}

function applyTemplateDemoContent(
  project: SiteProject,
  demo: TemplateDemoContent,
) {
  const updateEverySection = (
    type: SectionType,
    updates: Partial<SectionData>,
  ) => {
    for (const page of Object.values(project.pages)) {
      for (const section of page.sections) {
        if (section.type !== type) continue;
        Object.assign(section, {
          ...updates,
          items: updates.items ? copyDemoItems(updates.items) : updates.items,
        });
      }
    }
  };

  updateEverySection('hero', { subtitle: demo.tagline });
  updateEverySection('services-list', {
    title: 'Services',
    subtitle: 'Editable demo services for this template.',
    items: demo.services,
  });
  updateEverySection('faq', {
    title: 'Helpful questions',
    subtitle: 'Replace these demo answers with the details clients ask you most.',
    items: demo.faqs,
  });
  updateEverySection('testimonials', {
    title: 'What clients say',
    items: demo.testimonials,
  });
  updateEverySection('gallery', {
    title: 'Selected work',
    subtitle: 'Add your own images to turn these editable demo project cards into a portfolio.',
    items: demo.gallery,
  });
  updateEverySection('team', {
    title: 'Meet the team',
    items: demo.team,
  });
  updateEverySection('contact-form', {
    subtitle: 'Tell us a little about what you need. This is editable demo copy.',
  });
}

export function createNewProject(name: string, templateId: string): SiteProject {
  const template = TEMPLATES.find(t => t.id === templateId) || TEMPLATES[0];
  const demo = TEMPLATE_DEMO_CONTENT[template.id];
  const projectName = name.trim() || demo.business.name;
  
  const pages: Record<PageId, PageData> = {
    home: { id: 'home', name: 'Home', sections: [] },
    about: { id: 'about', name: 'About', sections: [] },
    services: { id: 'services', name: 'Services', sections: [] },
    contact: { id: 'contact', name: 'Contact', sections: [] }
  };

  const sectionOrder: Record<PageId, string[]> = { home: [], about: [], services: [], contact: [] };
  const hiddenSections: Record<PageId, string[]> = { home: [], about: [], services: [], contact: [] };

  template.supportedPages.forEach(pageId => {
    template.supportedSections[pageId].forEach(type => {
      const sec = createDefaultSection(type);
      pages[pageId].sections.push(sec);
      sectionOrder[pageId].push(sec.id);
    });
  });

  const project: SiteProject = {
    id: generateId(),
    name: projectName,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    activePageId: 'home',
    templateId: template.id,
    designTokens: { ...template.defaultTokens },
    business: {
      ...demo.business,
      name: projectName,
    },
    pages,
    sectionOrder,
    hiddenSections,
    receptionist: {
      enabled: false,
      assistantName: 'Assistant',
    },
  };

  const setSection = (pageId: PageId, type: SectionType, updates: Partial<SectionData>) => {
    const section = project.pages[pageId].sections.find(item => item.type === type);
    if (section) Object.assign(section, updates);
  };

  switch (template.id) {
    case 'home-services':
      project.business.category = 'Home Services';
      setSection('home', 'hero', {
        title: 'Dependable help for the home you love.',
        subtitle: 'Local professionals, clear quotes, and careful work from the first call to the final walk-through.',
        content: 'Request a quote'
      });
      setSection('home', 'features', {
        title: 'Service without the runaround',
        items: [
          { title: 'On-time arrival', description: 'Clear scheduling and updates before we reach your door.' },
          { title: 'Upfront pricing', description: 'A written quote with no surprise extras after the work begins.' },
          { title: 'Local accountability', description: 'A nearby team that stands behind every completed job.' }
        ]
      });
      break;
    case 'advisor':
      project.business.category = 'Business Advisory';
      setSection('home', 'hero', {
        title: 'Clarity for your next business decision.',
        subtitle: 'Practical financial and strategic guidance for Canadian owners who want a confident path forward.',
        content: 'Book a consultation'
      });
      setSection('home', 'features', {
        title: 'Advice built around your business',
        items: [
          { title: 'Clear priorities', description: 'Turn complex numbers into a focused action plan.' },
          { title: 'Senior attention', description: 'Work directly with an experienced advisor from day one.' },
          { title: 'Measured progress', description: 'Review the numbers that matter and adjust with confidence.' }
        ]
      });
      setSection('about', 'about-text', {
        title: 'Experienced counsel, plainly delivered.',
        content: 'We help owner-led companies make stronger decisions without adding unnecessary complexity. Every recommendation is practical, documented, and tied to the outcomes you care about.'
      });
      break;
    case 'cafe':
      project.business.category = 'Cafe & Kitchen';
      setSection('home', 'hero', {
        title: 'A neighbourhood table worth returning to.',
        subtitle: 'Seasonal plates, proper coffee, and the kind of welcome that turns a quick stop into a favourite ritual.',
        content: 'View our hours'
      });
      setSection('home', 'about-text', {
        title: 'Made here, served warmly.',
        content: 'Our small team works with local roasters, nearby farms, and time-tested recipes to make everyday food feel memorable.'
      });
      break;
    case 'wellness':
      project.business.category = 'Wellness Clinic';
      setSection('home', 'hero', {
        title: 'Care that meets you where you are.',
        subtitle: 'A calm, collaborative clinic for thoughtful treatment plans and sustainable progress.',
        content: 'Find your practitioner'
      });
      setSection('home', 'features', {
        title: 'A gentler path to feeling better',
        items: [
          { title: 'Personalized care', description: 'Sessions and plans shaped around your needs and pace.' },
          { title: 'Qualified practitioners', description: 'Experienced professionals with evidence-informed approaches.' },
          { title: 'Simple booking', description: 'Choose a time online and receive everything you need before your visit.' }
        ]
      });
      break;
    case 'creative':
      project.business.category = 'Creative Studio';
      setSection('home', 'hero', {
        title: 'We make brands hard to ignore.',
        subtitle: 'Strategy, identity, and digital work for ambitious teams ready to look as good as they operate.',
        content: 'Start a project'
      });
      setSection('home', 'features', {
        title: 'Big thinking. Useful outcomes.',
        items: [
          { title: 'Positioning', description: 'A sharp point of view your market can understand and remember.' },
          { title: 'Identity', description: 'A flexible visual language built for every customer touchpoint.' },
          { title: 'Digital', description: 'Web experiences that turn attention into action.' }
        ]
      });
      break;
    case 'plumber':
      project.business.category = 'Plumbing Services';
      setSection('home', 'hero', {
        title: 'Plumbing problems solved, without the runaround.',
        subtitle: 'Straightforward repairs, careful installations, and dependable help when your home needs it most.',
        content: 'Request service'
      });
      setSection('home', 'features', {
        title: 'Reliable from the first call',
        items: [
          { title: 'Clear arrival windows', description: 'Know when to expect us, with updates before we arrive.' },
          { title: 'Tidy workmanship', description: 'We protect your space and leave the job site clean.' },
          { title: 'Practical solutions', description: 'Helpful options explained in plain language before work begins.' }
        ]
      });
      setSection('home', 'services-list', {
        title: 'Plumbing services',
        items: [
          { title: 'Repairs', description: 'Leaks, clogs, fixtures, and everyday plumbing fixes.' },
          { title: 'Installations', description: 'New fixtures and plumbing updates for kitchens, baths, and laundry rooms.' },
          { title: 'Maintenance', description: 'Preventive checks that help keep small issues from becoming larger ones.' }
        ]
      });
      setSection('about', 'about-text', {
        title: 'A local plumber you can count on.',
        content: 'We take the time to understand the problem, explain the work clearly, and leave your home in good order. Our focus is practical, respectful service for every call.'
      });
      break;
    case 'electrician':
      project.business.category = 'Electrical Services';
      setSection('home', 'hero', {
        title: 'Safe, precise electrical work for every space.',
        subtitle: 'From quick repairs to full upgrades, we bring careful planning and clean workmanship to homes and businesses.',
        content: 'Book an assessment'
      });
      setSection('home', 'features', {
        title: 'Work built around safety',
        items: [
          { title: 'Thoughtful assessments', description: 'We start by understanding the issue and your space before recommending a path.' },
          { title: 'Clean installation', description: 'Neat, detail-oriented work that respects your home or job site.' },
          { title: 'Clear communication', description: 'Straight answers and updates throughout the project.' }
        ]
      });
      setSection('home', 'services-list', {
        title: 'Electrical services',
        items: [
          { title: 'Troubleshooting & repairs', description: 'Help identifying and resolving common electrical concerns.' },
          { title: 'Lighting & fixtures', description: 'Practical lighting upgrades for indoors, outdoors, and workspaces.' },
          { title: 'Panel & renovation work', description: 'Electrical planning and upgrades for evolving spaces.' }
        ]
      });
      setSection('home', 'stats', {
        title: 'A clear process',
        items: [
          { title: '1', description: 'Understand the job' },
          { title: '2', description: 'Explain the options' },
          { title: '3', description: 'Complete the work carefully' }
        ]
      });
      setSection('about', 'about-text', {
        title: 'Electrical service without the guesswork.',
        content: 'We pair technical care with plain-language communication, so you know what is happening at every stage of the job.'
      });
      break;
    case 'carpenter':
      project.business.category = 'Carpentry & Woodwork';
      setSection('home', 'hero', {
        title: 'Well-made spaces, built for everyday life.',
        subtitle: 'Custom carpentry, thoughtful renovations, and durable details shaped around how you live and work.',
        content: 'Discuss your project'
      });
      setSection('home', 'features', {
        title: 'Craft in the details',
        items: [
          { title: 'Custom fit', description: 'Built around your space, priorities, and the way you use it.' },
          { title: 'Lasting materials', description: 'Thoughtful material choices for a finish that feels right over time.' },
          { title: 'Careful execution', description: 'A tidy, collaborative process from first measurements to final details.' }
        ]
      });
      setSection('home', 'gallery', {
        title: 'Made for the space',
        subtitle: 'Add project photos to show the materials, joinery, and finish work that set your craft apart.',
        items: []
      });
      setSection('about', 'about-text', {
        title: 'Built with care, not shortcuts.',
        content: 'We create useful, lasting woodwork for homes and businesses. Every project begins with listening closely and ends with the details that make a space feel complete.'
      });
      setSection('services', 'services-list', {
        title: 'Carpentry services',
        items: [
          { title: 'Custom built-ins', description: 'Storage and display pieces tailored to your room and routines.' },
          { title: 'Finish carpentry', description: 'Trim, millwork, and details that give a space a finished feel.' },
          { title: 'Renovation carpentry', description: 'Practical craftsmanship for kitchens, living spaces, and commercial interiors.' }
        ]
      });
      break;
  }

  applyTemplateDemoContent(project, demo);
  project.receptionist = createReceptionistStarter(template.id, project.business);
  return project;
}

// Seed a polished, generic client project
export function getSeedProject(): SiteProject {
  const proj = createNewProject('Evergreen Home Services', 'home-services');
  proj.business = {
    name: 'Evergreen Home Services',
    category: 'Exterior Cleaning',
    city: 'Toronto',
    phone: '(416) 555-0184',
    email: 'hello@evergreenhomes.ca'
  };
  proj.receptionist = createReceptionistStarter(proj.templateId, proj.business);
  
  // Home page
  const home = proj.pages.home;
  const hero = home.sections.find(s => s.type === 'hero');
  if (hero) {
    hero.title = 'Your home, back in focus.';
    hero.subtitle = 'A small, careful exterior cleaning crew for Toronto homes that deserve more than a quick spray-and-go.';
    hero.content = 'Get a quote';
  }
  
  const features = home.sections.find(s => s.type === 'features');
  if (features) {
    features.title = 'The Evergreen Standard';
    features.items = [
      { title: 'Careful & Quiet', description: 'We treat your property with respect, keeping noise and disruption to a minimum.' },
      { title: 'Fully Insured', description: 'Comprehensive coverage for your peace of mind.' },
      { title: 'Eco-Friendly', description: 'Plant-safe solutions that protect your garden while cleaning your home.' }
    ];
  }

  const services = home.sections.find(s => s.type === 'services-list');
  if (services) {
    services.title = 'What we do best';
    services.subtitle = 'Professional exterior cleaning tailored for Toronto properties.';
    services.items = [
      { title: 'Window cleaning', description: 'Clear, streak-free glass that lets the light back in. Inside, outside, screens and sills.' },
      { title: 'House washing', description: 'A low-pressure wash that lifts years of grime from siding, brick, soffits and trim.' },
      { title: 'Eavestrough care', description: 'Clear channels, downspouts and guards so spring melt has somewhere safe to go.' }
    ];
  }

  const testimonials = home.sections.find(s => s.type === 'testimonials');
  if (testimonials) {
    testimonials.title = 'Trusted in Toronto';
    testimonials.items = [
      { title: 'Maya & Peter / Leslieville', description: 'They treated our old brick like it was their own house. The windows looked brand new, and the crew left the garden exactly as they found it.' },
      { title: 'Daniel / High Park', description: 'Fast reply, fair quote, no mess. Exactly what you hope for.' }
    ];
  }

  return proj;
}
