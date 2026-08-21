import type { MediaAsset, SiteProject } from './types';

export const MAX_PROJECT_MEDIA_ASSETS = 24;
export const MAX_PROJECT_MEDIA_DATA_LENGTH = 2_800_000;
export const MAX_LOCAL_PROJECTS_LENGTH = 4_300_000;

export function getProjectMediaAssets(project: SiteProject): MediaAsset[] {
  const assets = new Map<string, MediaAsset>();
  const add = (asset?: MediaAsset) => {
    if (asset) assets.set(asset.id, asset);
  };

  add(project.business.logo);
  Object.values(project.pages).forEach(page => {
    page.sections.forEach(section => {
      add(section.image);
      section.items?.forEach(item => add(item.image));
    });
  });

  return [...assets.values()];
}

export function getProjectMediaStats(project: SiteProject) {
  const assets = getProjectMediaAssets(project);
  return {
    count: assets.length,
    encodedLength: assets.reduce((total, asset) => total + asset.dataUrl.length, 0),
  };
}