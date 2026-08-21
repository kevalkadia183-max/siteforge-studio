import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
  Button, Input, Select, Textarea
} from '@/components/ui/forms';
import { Plus, Loader2 } from 'lucide-react';
import { useCreateLead, getListLeadsQueryKey, getGetLeadAcquisitionDashboardQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';

const createLeadSchema = z.object({
  businessName: z.string().min(1, 'Business name is required').max(300),
  email: z.string().email('Invalid email address').optional().or(z.literal('')),
  phone: z.string().max(50).optional().or(z.literal('')),
  websiteUrl: z.string().url('Invalid URL').optional().or(z.literal('')),
  category: z.string().max(128).optional().or(z.literal('')),
  city: z.string().max(128).optional().or(z.literal('')),
  region: z.string().max(128).optional().or(z.literal('')),
  country: z.string().max(64).optional().or(z.literal('')),
  websiteStatus: z.enum(['unknown', 'has_website', 'no_website', 'placeholder', 'outdated']).optional(),
  description: z.string().max(2000).optional().or(z.literal('')),
});

type CreateLeadForm = z.infer<typeof createLeadSchema>;

export function LeadCreateDialog() {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createLead = useCreateLead();

  const form = useForm<CreateLeadForm>({
    resolver: zodResolver(createLeadSchema),
    defaultValues: {
      businessName: '',
      email: '',
      phone: '',
      websiteUrl: '',
      category: '',
      city: '',
      region: '',
      country: '',
      websiteStatus: 'unknown',
      description: '',
    },
  });

  const onSubmit = async (data: CreateLeadForm) => {
    try {
      // Remove empty strings so we don't send empty strings to optional fields that might reject them
      // Actually we'll just send the empty string, the API usually handles it or we can undefine them
      const cleanedData = Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, v === '' ? undefined : v])
      ) as any;

      await createLead.mutateAsync({
        data: cleanedData,
      });

      toast({
        title: 'Lead created',
        description: `${data.businessName} has been added to your workspace.`,
      });
      
      form.reset();
      setOpen(false);

      // Invalidate queries to refresh the list and dashboard
      queryClient.invalidateQueries({ queryKey: getListLeadsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetLeadAcquisitionDashboardQueryKey() });
    } catch (error: any) {
      toast({
        title: 'Error creating lead',
        description: error.message || 'Something went wrong',
        variant: 'destructive',
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5 h-8 text-xs">
          <Plus size={14} /> Add Lead
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md sm:max-w-lg overflow-y-auto max-h-[90vh]">
        <DialogHeader>
          <DialogTitle>Add New Lead</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
            <FormField
              control={form.control}
              name="businessName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Business Name *</FormLabel>
                  <FormControl>
                    <Input placeholder="Acme Inc" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="contact@acme.com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Phone</FormLabel>
                    <FormControl>
                      <Input type="tel" placeholder="(555) 123-4567" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="websiteUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Website URL</FormLabel>
                    <FormControl>
                      <Input type="url" placeholder="https://acme.com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="websiteStatus"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Website Status</FormLabel>
                    <Select {...field}>
                      <option value="unknown">Unverified</option>
                      <option value="has_website">Has Website</option>
                      <option value="no_website">No Website</option>
                      <option value="placeholder">Placeholder</option>
                      <option value="outdated">Outdated</option>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Plumber, Cafe" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="city"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>City</FormLabel>
                    <FormControl>
                      <Input placeholder="Seattle" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="region"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Region / State</FormLabel>
                    <FormControl>
                      <Input placeholder="WA" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="country"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Country</FormLabel>
                    <FormControl>
                      <Input placeholder="US" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Any initial notes about this lead..." className="min-h-[80px]" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createLead.isPending}>
                {createLead.isPending && <Loader2 size={14} className="animate-spin mr-2" />}
                Create Lead
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
