import React, { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
  Button, Textarea, Label
} from '@/components/ui/forms';
import { Download, Loader2, AlertCircle } from 'lucide-react';
import { useImportLeads, getListLeadsQueryKey, getGetLeadAcquisitionDashboardQueryKey, type LeadImportItem } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';

function parseCSVRow(text: string): string[] {
  let inQuote = false;
  let current = '';
  const result: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuote) {
      if (char === '"') {
        if (text[i + 1] === '"') { // escaped quote
          current += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        current += char;
      }
    } else {
      if (char === '"') {
        inQuote = true;
      } else if (char === ',') {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
  }
  result.push(current.trim());
  return result;
}

export function LeadImportDialog() {
  const [open, setOpen] = useState(false);
  const [csvData, setCsvData] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const importLeads = useImportLeads();

  const handleImport = async () => {
    setError(null);
    if (!csvData.trim()) {
      setError('Please paste CSV data');
      return;
    }

    try {
      const lines = csvData.trim().split('\n');
      if (lines.length < 2) {
        throw new Error('CSV must have a header row and at least one data row');
      }
      if (lines.length > 101) {
        throw new Error('Maximum 100 leads allowed per import');
      }

      const headers = parseCSVRow(lines[0].toLowerCase());
      const businessNameIdx = headers.indexOf('businessname') !== -1 ? headers.indexOf('businessname') : headers.indexOf('name');
      
      if (businessNameIdx === -1) {
        throw new Error('CSV must contain a "businessName" or "name" column');
      }

      const items: LeadImportItem[] = [];

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const values = parseCSVRow(line);
        const businessName = values[businessNameIdx];
        
        if (!businessName) continue;
        
        const item: LeadImportItem = {
          businessName,
        };

        // Map optional fields
        const emailIdx = headers.indexOf('email');
        if (emailIdx !== -1 && values[emailIdx]) item.email = values[emailIdx];

        const phoneIdx = headers.indexOf('phone');
        if (phoneIdx !== -1 && values[phoneIdx]) item.phone = values[phoneIdx];

        const urlIdx = headers.indexOf('websiteurl') !== -1 ? headers.indexOf('websiteurl') : headers.indexOf('website');
        if (urlIdx !== -1 && values[urlIdx]) item.websiteUrl = values[urlIdx];

        const listingUrlIdx = headers.indexOf('listingurl');
        if (listingUrlIdx !== -1 && values[listingUrlIdx]) item.listingUrl = values[listingUrlIdx];

        const categoryIdx = headers.indexOf('category');
        if (categoryIdx !== -1 && values[categoryIdx]) item.category = values[categoryIdx];

        const addressIdx = headers.indexOf('address');
        if (addressIdx !== -1 && values[addressIdx]) item.address = values[addressIdx];
        
        const cityIdx = headers.indexOf('city');
        if (cityIdx !== -1 && values[cityIdx]) item.city = values[cityIdx];

        const regionIdx = headers.indexOf('region') !== -1 ? headers.indexOf('region') : headers.indexOf('state');
        if (regionIdx !== -1 && values[regionIdx]) item.region = values[regionIdx];

        const postalCodeIdx = headers.indexOf('postalcode') !== -1 ? headers.indexOf('postalcode') : headers.indexOf('zip');
        if (postalCodeIdx !== -1 && values[postalCodeIdx]) item.postalCode = values[postalCodeIdx];
        
        const countryIdx = headers.indexOf('country');
        if (countryIdx !== -1 && values[countryIdx]) item.country = values[countryIdx];
        
        const ratingIdx = headers.indexOf('rating');
        if (ratingIdx !== -1 && values[ratingIdx] && !isNaN(Number(values[ratingIdx]))) item.rating = Number(values[ratingIdx]);

        const reviewCountIdx = headers.indexOf('reviewcount') !== -1 ? headers.indexOf('reviewcount') : headers.indexOf('reviews');
        if (reviewCountIdx !== -1 && values[reviewCountIdx] && !isNaN(Number(values[reviewCountIdx]))) item.reviewCount = Number(values[reviewCountIdx]);
        
        const servicesIdx = headers.indexOf('services');
        if (servicesIdx !== -1 && values[servicesIdx]) item.services = values[servicesIdx];
        
        const websiteStatusIdx = headers.indexOf('websitestatus');
        if (websiteStatusIdx !== -1 && values[websiteStatusIdx]) item.websiteStatus = values[websiteStatusIdx] as any;
        
        const providerIdx = headers.indexOf('sourceprovider');
        if (providerIdx !== -1 && values[providerIdx]) item.sourceProvider = values[providerIdx];

        const referenceIdx = headers.indexOf('sourcereference');
        if (referenceIdx !== -1 && values[referenceIdx]) item.sourceReference = values[referenceIdx];
        
        const descriptionIdx = headers.indexOf('description') !== -1 ? headers.indexOf('description') : headers.indexOf('notes');
        if (descriptionIdx !== -1 && values[descriptionIdx]) item.description = values[descriptionIdx];

        items.push(item);
      }

      if (items.length === 0) {
        throw new Error('No valid leads found in CSV');
      }

      const res = await importLeads.mutateAsync({
        data: { items }
      });

      let skippedMessage = '';
      if (res.skipped > 0 && res.results) {
        const skippedRefs = res.results
          .filter(r => r.status === 'skipped')
          .map(r => r.duplicateLeadId ? `dup: ${r.duplicateLeadId}` : 'skipped')
          .slice(0, 5)
          .join(', ');
        skippedMessage = ` (Refs: ${skippedRefs}${res.skipped > 5 ? '...' : ''})`;
      }

      toast({
        title: 'Import complete',
        description: `Successfully imported ${res.created} leads. Skipped ${res.skipped}${skippedMessage}.`,
      });
      
      setCsvData('');
      setOpen(false);

      // Invalidate queries to refresh the list and dashboard
      queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLeadAcquisitionDashboardQueryKey() });
    } catch (err: any) {
      setError(err.message || 'Failed to parse or import CSV');
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5 h-8 text-xs">
          <Download size={14} /> Import
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import Leads</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label>Paste CSV Data</Label>
            <p className="text-xs text-muted-foreground">
              Required column: <code className="bg-muted px-1 rounded">businessName</code><br/>
              Optional columns: <code className="bg-muted px-1 rounded">email, phone, websiteUrl, city, category</code>
            </p>
            <Textarea 
              placeholder="businessName,email,city&#10;Acme Corp,contact@acme.com,Seattle" 
              className="min-h-[200px] font-mono text-sm" 
              value={csvData}
              onChange={e => setCsvData(e.target.value)}
            />
          </div>
          
          {error && (
            <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleImport} disabled={importLeads.isPending || !csvData.trim()}>
              {importLeads.isPending && <Loader2 size={14} className="animate-spin mr-2" />}
              Import
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
