create or replace function handle_track() returns trigger as $$
declare
  old_row tracks%ROWTYPE;
  new_val int;
  delta int := 0;
  parent_track_owner_id int;
  subscriber_user_ids int[];
begin
  insert into aggregate_track (track_id) values (new.track_id) on conflict do nothing;
  insert into aggregate_user (user_id) values (new.owner_id) on conflict do nothing;

  update aggregate_user 
  set track_count = (
    select count(*)
    from tracks t
    where t.is_current is true
      and t.is_delete is false
      and t.is_unlisted is false
      and t.is_available is true
      and t.stem_of is null
      and t.owner_id = new.owner_id
  )
  where user_id = new.owner_id
  ;

  -- If new track, create notification
  begin
    if new.is_unlisted = FALSE AND 
    new.is_available = True AND 
    new.is_delete = FALSE AND 
    new.is_playlist_upload = FALSE AND
    new.stem_of IS NULL THEN
      select array(
        select subscriber_id 
          from subscriptions 
          where is_current and 
          not is_delete and 
          user_id=new.owner_id
      ) into subscriber_user_ids;

      if array_length(subscriber_user_ids, 1)	> 0 then
        insert into notification
          (blocknumber, user_ids, timestamp, type, specifier, group_id, data)
        values
        (
          new.blocknumber,
          subscriber_user_ids,
          new.updated_at,
          'create',
          new.owner_id,
          'create:track:' || new.track_id,
          json_build_object('track_id', new.track_id)
        )
        on conflict do nothing;
      end if;
    end if;
	exception
		when others then null;
	end;

  -- If remix, create notification
  begin
    if new.remix_of is not null AND
    new.is_unlisted = FALSE AND
    new.is_available = true AND
    new.is_delete = FALSE AND
    new.stem_of IS NULL then
      select owner_id into parent_track_owner_id from tracks where is_current and track_id = (new.remix_of->'tracks'->0->>'parent_track_id')::int limit 1;
      if parent_track_owner_id is not null then
        insert into notification
        (blocknumber, user_ids, timestamp, type, specifier, group_id, data)
        values
        (
          new.blocknumber,
          ARRAY [parent_track_owner_id],
          new.updated_at,
          'remix',
          new.owner_id,
          'remix:track:' || new.track_id || ':parent_track:' || (new.remix_of->'tracks'->0->>'parent_track_id')::int || ':blocknumber:' || new.blocknumber,
          json_build_object('track_id', new.track_id, 'parent_track_id', (new.remix_of->'tracks'->0->>'parent_track_id')::int)
        )
        on conflict do nothing;
      end if;
    end if;
	exception
		when others then null;
	end;

  return null;
end;
$$ language plpgsql;



do $$ begin
  create trigger on_track
  after insert or update on tracks
  for each row execute procedure handle_track();
exception
  when others then null;
end $$;
