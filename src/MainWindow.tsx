import { RouterProvider } from "@tanstack/react-router";
import { router } from "@/lib/router";

/** The router and application shell are needed only by the main window. */
export default function MainWindow(): React.JSX.Element {
  return <RouterProvider router={router} />;
}
