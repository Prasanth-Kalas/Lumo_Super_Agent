import { redirect } from "next/navigation";
import {
  WebhookEditForm,
  WebhookRegistrationForm,
} from "@/components/developer/DeveloperForms";
import { getServerUser } from "@/lib/auth";
import { listDeveloperWebhooks } from "@/lib/developer-dashboard";
import { EmptyState, PageHeading, Panel } from "../_components";

export const dynamic = "force-dynamic";

export default async function DeveloperWebhooksPage() {
  const user = await getServerUser();
  if (!user) redirect("/login?next=/developer/webhooks");
  const webhooks = await listDeveloperWebhooks(user.id);
  return (
    <div className="space-y-6">
      <PageHeading
        title="Webhooks"
        description="Register HTTPS endpoints for install, uninstall, version, promotion, and future transaction events."
      />
      <Panel title="Register webhook">
        <WebhookRegistrationForm />
      </Panel>
      <Panel title="Registered endpoints" meta={`${webhooks.length} rows`}>
        {webhooks.length === 0 ? (
          <EmptyState text="No webhook registrations yet." />
        ) : (
          <div className="space-y-2">
            {webhooks.map((hook) => (
              <WebhookEditForm key={hook.id} webhook={hook} />
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
