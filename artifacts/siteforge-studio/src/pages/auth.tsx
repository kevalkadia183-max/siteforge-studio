import { SignIn, SignUp } from '@clerk/react';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-4">
      <div className="mb-8 flex items-center justify-center space-x-3">
        <img src={`${window.location.origin}${basePath}/logo.svg`} alt="SiteForge Logo" className="h-8 w-8" />
        <span className="font-sans text-2xl font-bold tracking-tight">SiteForge</span>
      </div>
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

export function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-background px-4">
      <div className="mb-8 flex items-center justify-center space-x-3">
        <img src={`${window.location.origin}${basePath}/logo.svg`} alt="SiteForge Logo" className="h-8 w-8" />
        <span className="font-sans text-2xl font-bold tracking-tight">SiteForge</span>
      </div>
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}
