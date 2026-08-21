import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applySelectedBriefDraftToHistory,
  buildSelectedBriefDraftProject,
  createBriefDraft,
  createBriefDraftSelection,
  getSelectedBriefDraftChangeCount,
} from './brief-generator';
import { createNewProject } from './templates';
import type { BriefDraftSelection, ClientBrief, PageId } from './types';

const pageIds: PageId[] = ['home', 'about', 'services', 'contact'];

const brief: ClientBrief = {
  businessType: 'Residential plumber',
  services: 'Leak repair, Drain cleaning, Water heaters',
  location: 'Calgary',
  audience: 'Homeowners',
  differentiators: 'Same-day help and transparent estimates',
  tone: 'friendly',
};

function excludeEveryChange(selection: BriefDraftSelection): BriefDraftSelection {
  return {
    business: { category: false, location: false },
    sections: Object.fromEntries(pageIds.map((pageId) => [
      pageId,
      Object.fromEntries(Object.keys(selection.sections[pageId]).map((sectionId) => [sectionId, false])),
    ])) as BriefDraftSelection['sections'],
  };
}

describe('brief draft selection', () => {
  it('initially includes every proposed change', () => {
    const source = createNewProject('Selection Test', 'home-services');
    const draft = createBriefDraft(source, brief);
    const selection = createBriefDraftSelection(draft);
    const sectionChangeCount = pageIds.reduce(
      (total, pageId) => total + draft.changedSectionIds[pageId].length,
      0,
    );

    assert.equal(selection.business.category, true);
    assert.equal(selection.business.location, true);
    assert.equal(
      getSelectedBriefDraftChangeCount(draft, selection),
      sectionChangeCount + 2,
    );
    for (const pageId of pageIds) {
      for (const sectionId of draft.changedSectionIds[pageId]) {
        assert.equal(selection.sections[pageId][sectionId], true);
      }
    }
  });

  it('applies only selected business fields and sections without mutating the source', () => {
    const source = createNewProject('Partial Apply Test', 'home-services');
    const sourceSnapshot = structuredClone(source);
    const draft = createBriefDraft(source, brief);
    const selection = excludeEveryChange(createBriefDraftSelection(draft));
    const homeHeroId = draft.changedSectionIds.home[0];
    const servicesFaqId = draft.project.pages.services.sections
      .find((section) => section.type === 'faq')?.id;

    assert.ok(homeHeroId);
    assert.ok(servicesFaqId);
    selection.business.location = true;
    selection.sections.home[homeHeroId] = true;
    selection.sections.services[servicesFaqId] = true;

    const result = buildSelectedBriefDraftProject(draft, selection);
    const sourceHero = source.pages.home.sections.find((section) => section.id === homeHeroId);
    const proposedHero = draft.project.pages.home.sections.find((section) => section.id === homeHeroId);
    const resultHero = result.pages.home.sections.find((section) => section.id === homeHeroId);
    const skippedHomeSection = source.pages.home.sections.find((section) => section.id !== homeHeroId);
    const resultSkippedHomeSection = result.pages.home.sections
      .find((section) => section.id === skippedHomeSection?.id);
    const proposedFaq = draft.project.pages.services.sections
      .find((section) => section.id === servicesFaqId);
    const resultFaq = result.pages.services.sections.find((section) => section.id === servicesFaqId);

    assert.equal(result.business.category, source.business.category);
    assert.equal(result.business.city, draft.project.business.city);
    assert.notDeepEqual(resultHero, sourceHero);
    assert.deepEqual(resultHero, proposedHero);
    assert.deepEqual(resultSkippedHomeSection, skippedHomeSection);
    assert.deepEqual(resultFaq, proposedFaq);
    assert.equal(getSelectedBriefDraftChangeCount(draft, selection), 3);
    assert.deepEqual(source, sourceSnapshot);
  });

  it('leaves the complete project unchanged when every proposal is skipped', () => {
    const source = createNewProject('Skip All Test', 'home-services');
    const draft = createBriefDraft(source, brief);
    const selection = excludeEveryChange(createBriefDraftSelection(draft));

    assert.equal(getSelectedBriefDraftChangeCount(draft, selection), 0);
    assert.deepEqual(buildSelectedBriefDraftProject(draft, selection), source);
  });

  it('records a mixed selection as exactly one undoable history entry', () => {
    const older = createNewProject('Older Version', 'home-services');
    const source = createNewProject('Undo Test', 'home-services');
    const draft = createBriefDraft(source, brief);
    const selection = excludeEveryChange(createBriefDraftSelection(draft));
    const heroId = draft.changedSectionIds.home[0];
    const future = createNewProject('Discarded Future', 'home-services');
    selection.business.location = true;
    selection.sections.home[heroId] = true;

    const result = applySelectedBriefDraftToHistory(
      { past: [older], present: source, future: [future] },
      draft,
      selection,
      123456,
    );

    assert.equal(result.applied, true);
    assert.ok(result.history);
    assert.equal(result.history.past.length, 2);
    assert.equal(result.history.past.at(-1), source);
    assert.deepEqual(result.history.future, []);
    assert.equal(result.history.present.updatedAt, 123456);
    assert.equal(result.history.present.business.city, brief.location);
    assert.equal(result.history.present.business.category, source.business.category);
    assert.deepEqual(result.history.past.at(-1), source);
  });

  it('rejects a stale draft without changing history', () => {
    const source = createNewProject('Stale Draft Test', 'home-services');
    const draft = createBriefDraft(source, brief);
    const selection = createBriefDraftSelection(draft);
    const currentHistory = {
      past: [],
      present: { ...source, updatedAt: source.updatedAt + 1 },
      future: [],
    };

    const result = applySelectedBriefDraftToHistory(
      currentHistory,
      draft,
      selection,
      123456,
    );

    assert.equal(result.applied, false);
    assert.equal(result.history, currentHistory);
  });

  it('does not select unchanged business details', () => {
    const source = createNewProject('Unchanged Business Test', 'home-services');
    const draft = createBriefDraft(source, {
      ...brief,
      businessType: source.business.category,
      location: source.business.city,
    });
    const selection = createBriefDraftSelection(draft);
    const sectionChangeCount = pageIds.reduce(
      (total, pageId) => total + draft.changedSectionIds[pageId].length,
      0,
    );

    assert.deepEqual(selection.business, { category: false, location: false });
    assert.equal(
      getSelectedBriefDraftChangeCount(draft, selection),
      sectionChangeCount,
    );
  });
});