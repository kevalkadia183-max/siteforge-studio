import React, { useEffect, useRef } from 'react';
import { Monitor, Smartphone, Tablet, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import { GeneratedSite } from '../lib/generator';

type PreviewProps = {
  site: GeneratedSite;
  activePageId: string;
  device: 'desktop' | 'tablet' | 'mobile';
  onDeviceChange: (d: 'desktop' | 'tablet' | 'mobile') => void;
};

export function StudioPreview({ site, activePageId, device, onDeviceChange }: PreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  
  const filename = activePageId === 'home' ? 'index.html' : `${activePageId}.html`;
  const rawHtml = site.pages[filename] || '';

  useEffect(() => {
    if (!iframeRef.current) return;
    
    // Inject generated HTML into iframe, replacing linked CSS/JS with inline content
    let inlineHtml = rawHtml;
    if (inlineHtml) {
      // Generated sites detect this marker to replace side effects such as a
      // mail-client handoff with a safe, visible preview result. It exists
      // only in Studio's in-memory iframe, never in exports or published sites.
      inlineHtml = inlineHtml.replace('<html lang="en">', '<html lang="en" data-siteforge-preview>');
      inlineHtml = inlineHtml.replace('<link rel="stylesheet" href="styles.css">', `<style>${site.css}</style>`);
      inlineHtml = inlineHtml.replace('<script src="main.js"></script>', `<script>${site.js}</script>`);
      inlineHtml = inlineHtml.replace(/(src=")assets\/([^"]+)(")/g, (_match, before, filename, after) => {
        const asset = site.media[filename];
        return asset ? `${before}${asset.dataUrl}${after}` : '';
      });
    } else {
      inlineHtml = `<div style="font-family: sans-serif; text-align: center; padding: 2rem; color: #6b7280;">Page not available for this template.</div>`;
    }
    
    // Store scroll pos if we want to get fancy, but srcdoc resets it anyway.
    iframeRef.current.srcdoc = inlineHtml;
  }, [rawHtml, site.css, site.js]);

  return (
    <div className="w-full h-full flex flex-col bg-muted/30 relative">
      <div className="h-12 border-b border-border flex items-center justify-between px-4 bg-card z-10 shrink-0">
        <div className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <span className="bg-muted px-2 py-0.5 rounded text-foreground">{filename}</span>
        </div>
        <div className="flex bg-muted/50 rounded-md p-0.5 border border-border/50">
          <button
            onClick={() => onDeviceChange('desktop')}
            className={cn(
              "px-3 py-1 rounded-sm text-sm font-medium flex items-center gap-2 transition-all",
              device === 'desktop' ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            data-testid="btn-device-desktop"
          >
            <Monitor size={14} /> <span className="hidden sm:inline">Desktop</span>
          </button>
          <button
            onClick={() => onDeviceChange('tablet')}
            className={cn(
              "px-3 py-1 rounded-sm text-sm font-medium flex items-center gap-2 transition-all",
              device === 'tablet' ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            data-testid="btn-device-tablet"
            title="Tablet preview"
          >
            <Tablet size={14} /> <span className="hidden sm:inline">Tablet</span>
          </button>
          <button
            onClick={() => onDeviceChange('mobile')}
            className={cn(
              "px-3 py-1 rounded-sm text-sm font-medium flex items-center gap-2 transition-all",
              device === 'mobile' ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            data-testid="btn-device-mobile"
          >
            <Smartphone size={14} /> <span className="hidden sm:inline">Mobile</span>
          </button>
        </div>
        <button 
          onClick={() => {
            if (iframeRef.current) {
              const current = iframeRef.current.srcdoc;
              iframeRef.current.srcdoc = '';
              setTimeout(() => { if (iframeRef.current) iframeRef.current.srcdoc = current; }, 50);
            }
          }}
          className="text-muted-foreground hover:text-foreground p-1.5"
          title="Reload Preview"
          data-testid="btn-reload-preview"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-auto flex items-center justify-center p-4 sm:p-8 bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCI+CgkJPHBhdGggZD0iTTAgMGg0MHY0MEgweiIgZmlsbD0ibm9uZSIvPgoJCTxwYXRoIGQ9Ik0wIDEwaDQwdjFINHoiIGZpbGw9InJnYmEoMjU1LDI1NSwyNTUsMC4wMykiLz4KCQk8cGF0aCBkPSJNMTAgMHY0MGgxVjB6IiBmaWxsPSJyZ2JhKDI1NSwyNTUsMjU1LDAuMDMpIi8+Cjwvc3ZnPg==')]">
        <div 
          className={cn(
            "bg-white shadow-2xl overflow-hidden transition-all duration-300 ease-out origin-top border border-border/50 flex flex-col",
            device === 'desktop'
              ? "w-full max-w-[1200px] h-[85vh] rounded-xl"
              : device === 'tablet'
                ? "w-[768px] h-[1024px] rounded-[1.5rem] border-4 border-muted-foreground/20"
                : "w-[375px] h-[812px] rounded-[2rem] border-4 border-muted-foreground/20"
          )}
        >
          {device !== 'mobile' && (
            <div className="w-full h-6 bg-muted border-b border-border/50 flex items-center px-4 gap-1.5 shrink-0">
              <div className="w-2.5 h-2.5 rounded-full bg-border"></div>
              <div className="w-2.5 h-2.5 rounded-full bg-border"></div>
              <div className="w-2.5 h-2.5 rounded-full bg-border"></div>
            </div>
          )}
          {device === 'mobile' && (
            <div className="w-full h-6 bg-black flex items-center justify-center shrink-0">
              <div className="w-32 h-4 bg-black rounded-b-xl"></div>
            </div>
          )}
          <iframe
            ref={iframeRef}
            className="w-full flex-1 bg-white"
            title="Site Preview"
            sandbox="allow-scripts"
            data-testid="preview-iframe"
          />
        </div>
      </div>
    </div>
  );
}