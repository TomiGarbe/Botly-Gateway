"""Phone evidence belongs to a provider participant, never to a group or a LID's digits."""

import re


def phone_from_jid(value):
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"([1-9][0-9]{6,14})(?::[0-9]+)?@s\.whatsapp\.net", value)
    return match[1] if match else None


def participant_directory(groups):
    result = {}
    count = 0
    for group in groups:
        members = group.get('participants') or []
        if not isinstance(members, list):
            raise ValueError('invalid_participant_directory')
        phones, ambiguous = {}, set()
        for member in members:
            if not isinstance(member, dict):
                continue
            phone = phone_from_jid(member.get('phoneNumber')) or phone_from_jid(member.get('id'))
            identity = member.get('id')
            if not phone or not isinstance(identity, str) or not identity.endswith(('@lid', '@s.whatsapp.net')):
                continue
            if identity in phones and phones[identity] != phone:
                ambiguous.add(identity)
            phones[identity] = phone
            count += 1
            if count > 10000:
                raise ValueError('participant_directory_capacity')
        result[group['id']] = {key: value for key, value in phones.items() if key not in ambiguous}
    return result


def author_phone(key, record, group_id):
    identity = key.get('participant')
    if not isinstance(identity, str) or not identity.endswith(('@lid', '@s.whatsapp.net')):
        return None
    evidence = set()
    direct = phone_from_jid(identity)
    alternate = phone_from_jid(key.get('participantAlt'))
    cached = ((record.get('core_channel') or {}).get('participantPhones') or {}).get(group_id, {}).get(identity)
    for phone in (direct, alternate, cached):
        if isinstance(phone, str) and re.fullmatch(r'[1-9][0-9]{6,14}', phone):
            evidence.add(phone)
    return next(iter(evidence)) if len(evidence) == 1 else None
