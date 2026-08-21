import { Link } from 'wouter';
import { Button } from '@/components/ui/button';
import { ArrowRight, Globe, Zap, Paintbrush } from 'lucide-react';

export function LandingPage() {
  return (
    <div className="flex min-h-[100dvh] flex-col bg-background text-foreground selection:bg-primary selection:text-primary-foreground">
      {/* Navbar */}
      <header className="sticky top-0 z-50 flex h-20 items-center justify-between border-b border-border/40 bg-background/80 px-6 backdrop-blur-md md:px-12">
        <div className="flex items-center space-x-3">
          <img src={`${import.meta.env.BASE_URL.replace(/\/$/, "")}/logo.svg`} alt="SiteForge Logo" className="h-8 w-8" />
          <span className="font-sans text-xl font-bold tracking-tight">SiteForge</span>
        </div>
        <div className="flex items-center space-x-4">
          <Link href="/sign-in" className="text-sm font-medium hover:text-primary transition-colors">
            Log in
          </Link>
          <Link href="/sign-up">
            <Button className="rounded-full px-6 shadow-md transition-transform hover:-translate-y-0.5">
              Get Started
            </Button>
          </Link>
        </div>
      </header>

      {/* Hero Section */}
      <main className="flex-1">
        <section className="relative overflow-hidden px-6 pt-24 pb-32 md:px-12 md:pt-32 lg:pt-48">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-primary/10 via-background to-background" />
          <div className="mx-auto max-w-5xl text-center relative z-10">
            <h1 className="font-sans text-5xl font-extrabold tracking-tight sm:text-6xl lg:text-7xl">
              The creative workshop for <br className="hidden md:block" />
              <span className="text-primary">service businesses.</span>
            </h1>
            <p className="mx-auto mt-8 max-w-2xl text-lg text-muted-foreground md:text-xl leading-relaxed">
              SiteForge is a fast, polished website studio built to help small service businesses establish a striking online presence. No bloated templates. No generic designs. Just pure craft.
            </p>
            <div className="mt-12 flex flex-col items-center justify-center space-y-4 sm:flex-row sm:space-x-6 sm:space-y-0">
              <Link href="/sign-up">
                <Button size="lg" className="h-14 rounded-full px-8 text-lg shadow-lg transition-transform hover:-translate-y-1">
                  Start Building <ArrowRight className="ml-2 h-5 w-5" />
                </Button>
              </Link>
              <Link href="/sign-in">
                <Button variant="outline" size="lg" className="h-14 rounded-full px-8 text-lg hover:bg-secondary">
                  Return to Studio
                </Button>
              </Link>
            </div>
          </div>
        </section>

        {/* Features Grid */}
        <section className="border-t border-border/40 bg-secondary/30 px-6 py-24 md:px-12 lg:py-32">
          <div className="mx-auto max-w-6xl">
            <div className="grid gap-12 md:grid-cols-3">
              <div className="flex flex-col items-start text-left">
                <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Zap className="h-7 w-7" />
                </div>
                <h3 className="mb-3 font-sans text-2xl font-bold">Responsive Preview</h3>
                <p className="text-muted-foreground leading-relaxed">
                  See your service site take shape across desktop and mobile views while you work, with a preview that stays close to the canvas.
                </p>
              </div>
              <div className="flex flex-col items-start text-left">
                <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Paintbrush className="h-7 w-7" />
                </div>
                <h3 className="mb-3 font-sans text-2xl font-bold">Temporary Share Preview</h3>
                <p className="text-muted-foreground leading-relaxed">
                  Send a temporary preview link to a client or collaborator when the work is ready for a second set of eyes.
                </p>
              </div>
              <div className="flex flex-col items-start text-left">
                <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                  <Globe className="h-7 w-7" />
                </div>
                <h3 className="mb-3 font-sans text-2xl font-bold">Dependency-Free Export</h3>
                <p className="text-muted-foreground leading-relaxed">
                  Download a clean ZIP of your finished site without a framework or package setup standing between you and the files.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/40 bg-background px-6 py-12 text-center md:px-12">
        <p className="text-sm text-muted-foreground">
          © {new Date().getFullYear()} SiteForge Studio. Crafted with intent.
        </p>
      </footer>
    </div>
  );
}
