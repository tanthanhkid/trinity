# Facebook Page comments, Messenger and the Interactions screen

Module `services/crm/src/facebook/` (comments, Messenger, webhook) and `services/crm/src/interactions/` (the combined timeline).
Connection status per feature: [status.md](status.md). AI tools: [mcp.md](mcp.md#facebook-page--messenger).

## Webhook: one Meta app, one deployment
A Meta app has **one** callback URL for its Page webhooks. Comments and Messenger messages therefore reach only the deployment that URL
points to. If you run several deployments (production, a demo, a test instance) with the same Meta app, only one of them receives events;
the others see their Pages as connected but never get new comments or messages. Use a separate Meta app per deployment that must receive
events, or accept that the others are send-only.

The callback is `https://<domain>/api/v1/facebook/webhook`; the verify token is `FACEBOOK_WEBHOOK_VERIFY_TOKEN`. Subscribe the app to the
Page fields `feed` (comments) and `messages`.

## Turning a Page off, and reconnecting
Under **Connections › Facebook Page** each Page can be switched off (`is_active = false`): its events are ignored and it is not offered for
posting. **Connecting Facebook again (the OAuth flow) switches every Page that the login grants back on**, including Pages you had turned off.
After a reconnect, check the list and switch off again the Pages that should stay off.

## Comment rules
A rule matches incoming comments by keywords (or every comment) on chosen posts or all posts of a Page, and can:
reply publicly (one of several texts, picked at random), send one private reply in Messenger, and hide the comment when it contains a
phone number. Rules are tried in their list order. Results are recorded on the comment.

Independently of rules, every comment is linked to a customer: a matching phone number, then an earlier comment by the same person,
then the Messenger contact; otherwise a new customer is created (with the Page's customer source and default assignee) when the
commenter is known or left a phone number.

- Screen: the comments view of the Facebook inbox (rule list and rule form).
- Targeting a specific post needs its post id. For a Page **cover photo** or any photo, the post id is `<page_id>_<photo fbid>`
  (the `fbid` from the photo link), not the photo id alone. Links copied from another Page are rejected rather than guessed.
- AI tools: `list_facebook_comment_rules`, `create_comment_rule`, `update_comment_rule` (preview, then `confirmed_by_user`),
  `test_comment_rule` (dry run on a sample comment, sends nothing). There is no delete tool; rules are switched off or removed in the UI.

## Notifications (bell)
A new comment, Messenger message or Zalo OA message creates a bell notification for: the customer's owner, the channel's default
assignee, and users with the "Manage webhooks" permission. Every comment notifies; messages notify at most once per conversation every
3 minutes. The link opens the conversation (comments open the Interactions screen). Comment notifications include what the rule did ("Luật … đã trả lời").

## Interactions screen (Tương tác)
`/inbox?kenh=tuong-tac`, the first tab of the inbox whenever a chat channel is on. One timeline of Fanpage comments, Messenger
conversations and Zalo OA threads with:
- counters: messages today, comments today, handled by rules today, unanswered in the last 7 days;
- filters: channel, type, Page, rule ran / no rule, unanswered, date range, search;
- per item: status (staff replied, rule replied, answered, unanswered), the rule result, a link to the post, and a reply box in place.

API: `GET /interactions`, `GET /interactions/stats`, `GET /interactions/comments/:id/thread`. Visibility follows the same permissions as
the inbox and the Facebook Page / Zalo OA features. AI tool: `list_interactions` (read; dates given as `YYYY-MM-DD` mean whole days in
Vietnam time).
