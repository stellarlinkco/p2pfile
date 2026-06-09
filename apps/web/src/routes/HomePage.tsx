import { HomePageView } from "./HomePageView";
import { useSenderFlow } from "./home-flow";

export function HomePage() {
  const sender = useSenderFlow();
  return <HomePageView sender={sender} />;
}
