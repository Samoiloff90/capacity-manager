import ProjectApp from "./ProjectApp";
import { ProjectWorkspaceProvider } from "./project-workspace";

export default function App() {
  return <ProjectWorkspaceProvider><ProjectApp /></ProjectWorkspaceProvider>;
}
