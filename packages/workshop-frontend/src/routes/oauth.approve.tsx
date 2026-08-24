import { createFileRoute } from '@tanstack/react-router'
import OAuthApprovePage from '../OAuthApprovePage'

/** The `?request=` handle `/oauth/authorize` redirects here with. */
type ApproveSearch = {
  request: string
}

export const Route = createFileRoute('/oauth/approve')({
  component: OAuthApprovePage,
  // A missing or non-string `request` normalizes to the empty string rather than throwing: the page
  // already has a "this request is no longer valid" state, and an unparseable URL is exactly that.
  validateSearch: (search: Record<string, unknown>): ApproveSearch => ({
    request: typeof search.request === 'string' ? search.request : '',
  }),
})
