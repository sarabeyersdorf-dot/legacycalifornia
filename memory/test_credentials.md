# Test credentials — Legacy Properties

Both of Sara's accounts now have role `agent_sara` in `public.users`. Either works for the CRM. James's account is the only `agent_james`.

## Agent accounts (full CRM access)
| Email                              | Role         | Auth UID                                |
| ---------------------------------- | ------------ | --------------------------------------- |
| `sarasellscalifornia@gmail.com`    | `agent_sara` | `b9538c54-af56-41ca-9876-2cde4b63dc0d` |
| `sarabeyersdorf@gmail.com`         | `agent_sara` | `31104ecb-f4e8-4127-8053-0cb9f514d1d8` |
| `jamessellscalifornia@gmail.com`   | `agent_james`| `1818a5a4-c4bf-4272-bb86-0602a8461749` |

Passwords held by Sara. Auth provider: Supabase email/password + magic-link.

## Notes for future agents
- Default trigger on `auth.users` insert assigns role `buyer`. To grant CRM access:
  ```sql
  update public.users set role='agent_sara', display_name='Sara Cooper'
   where id = (select id from auth.users where email = 'newemail@example.com');
  ```
- The CRM front-end gate checks `isAgent(profile)` in `api/_lib/auth.js`, which whitelists `['agent_sara','agent_james','admin']`.
