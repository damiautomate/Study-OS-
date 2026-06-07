import OnboardingView from "./OnboardingView";

export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OnboardingView courseId={id} />;
}
