import React, { useState } from 'react';
import { Check, Download, FileArchive, Play } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './ui/forms';
import { GeneratedSite } from '../lib/generator';
import { hasAbsoluteHostedApiUrl } from '../lib/generator';
import JSZip from 'jszip';

type ExportDialogProps = {
  site: GeneratedSite;
  businessName: string;
  hasReceptionist: boolean;
  hostedApiUrl?: string;
};

export function ExportDialog({ site, businessName, hasReceptionist, hostedApiUrl }: ExportDialogProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [exported, setExported] = useState(false);

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const zip = new JSZip();
      
      // Add pages
      Object.entries(site.pages).forEach(([filename, html]) => {
        zip.file(filename, html);
      });
      
      // Add assets
      zip.file('styles.css', site.css);
      zip.file('main.js', site.js);
       Object.entries(site.media).forEach(([filename, asset]) => {
         const base64 = asset.dataUrl.split(',', 2)[1];
         if (base64) zip.file(`assets/${filename}`, base64, { base64: true });
       });
      
      const blob = await zip.generateAsync({ type: 'blob' });
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = businessName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      a.download = `${safeName || 'siteforge'}-export.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      setExported(true);
      setTimeout(() => setExported(false), 3000);
    } catch (e) {
      console.error('Export failed', e);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button className="gap-2 font-semibold" data-testid="btn-open-export">
          <Download size={16} /> Export Site
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-2xl">Export {businessName}</DialogTitle>
          <DialogDescription>
            Download your production-ready, dependency-free static files.
          </DialogDescription>
        </DialogHeader>
        
        <div className="mt-6 space-y-6">
          <div className="flex flex-col items-center justify-center p-8 border-2 border-dashed border-border rounded-xl bg-muted/20">
            <FileArchive size={48} className="text-muted-foreground mb-4" />
            <Button 
              size="lg"
              className="gap-2 w-full sm:w-auto"
              onClick={handleExport}
              disabled={isExporting || exported}
              data-testid="btn-download-zip"
            >
              {exported ? (
                <><Check size={18} /> Export Complete</>
              ) : isExporting ? (
                "Zipping files..."
              ) : (
                <><Download size={18} /> Download ZIP Archive</>
              )}
            </Button>
            <p className="text-xs text-muted-foreground mt-3">
              Contains {Object.keys(site.pages).length} HTML files, styles.css, main.js{Object.keys(site.media).length ? `, and ${Object.keys(site.media).length} image file${Object.keys(site.media).length === 1 ? '' : 's'}` : ''}.
            </p>
          </div>

          <div className="bg-card rounded-lg p-5 border border-border shadow-sm">
            <h3 className="font-semibold flex items-center gap-2 mb-3 text-sm">
              <Play size={16} className="text-primary" /> Launch Instructions
            </h3>
            <ul className="space-y-2.5 text-sm text-muted-foreground list-decimal pl-5">
              <li>
                <strong className="text-foreground font-medium">Extract the ZIP:</strong> Unzip the downloaded file on your computer.
              </li>
              <li>
                <strong className="text-foreground font-medium">Host the files:</strong> Upload the extracted folder contents to any static hosting provider (e.g. Netlify, Vercel, GitHub Pages, or cPanel).
              </li>
              <li>
                <strong className="text-foreground font-medium">Connect your form:</strong> The included form opens the visitor&apos;s email app. To use Formspree, Netlify Forms, or your own endpoint instead, replace the contact form submit handler in <code className="bg-muted px-1.5 py-0.5 rounded border border-border text-xs">main.js</code>.
              </li>
              {hasReceptionist && (
                <li>
                  <strong className="text-foreground font-medium">AI Receptionist:</strong> The static files are entirely offline-ready, with the exception of the AI Receptionist chat. The chat widget requires API requests to your deployed SiteForge API endpoint to function.
                  {!hasAbsoluteHostedApiUrl(hostedApiUrl) && (
                    <span className="block mt-1 text-amber-600 font-medium">
                      Warning: You have not configured a Hosted API URL in the sidebar settings. The widget will not work when deployed until you set an absolute URL (e.g. https://api.yoursite.com).
                    </span>
                  )}
                </li>
              )}
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
