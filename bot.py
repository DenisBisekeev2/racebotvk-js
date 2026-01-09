import vk_api
from vk_api.longpoll import VkLongPoll, VkEventType
import json
import os

# Авторизация
token = "vk1.a.MTzBXxQQyLu72tOMdVYarZLJ3yOOmHXJ2d-MIyWIw55LLJnAryrh1ueQTmh7lsmNXYYyLaU8c59brz9S2gBZ1YK_5HYujr809X2mn7N8OlHwOGiIVOzRJ"
vk_session = vk_api.VkApi(token=token)
vk = vk_session.get_api()
longpoll = VkLongPoll(vk_session)
upload = vk_api.VkUpload(vk_session)

def send_message(peer_id, message, attachment=None):
    vk.messages.send(
        peer_id=peer_id,
        message=message,
        random_id=0,
        attachment=attachment
    )

print("Бот запущен...")

for event in longpoll.listen():
    if event.type == VkEventType.MESSAGE_NEW and event.to_me:
        # 1. Логирование каждого сообщения
        user_info = f"ID: {event.user_id}"
        print(f"[LOG] Сообщение от {user_info} в {event.peer_id}: {event.text}")

        # 2. Обработка команды /db
        if event.text.lower() == "/db":
            # Проверка на нужный peer_id
            if event.peer_id == 2000000010:
                files_to_send = ["admin.json", "users.json", "payments.json"]
                attachments = []

                try:
                    for file_path in files_to_send:
                        if os.path.exists(file_path):
                            # Загрузка документа
                            doc = upload.document_message(file_path, title=file_path, peer_id=event.peer_id)['doc']
                            attachments.append(f"doc{doc['owner_id']}_{doc['id']}")
                        else:
                            print(f"Файл {file_path} не найден")

                    if attachments:
                        send_message(event.peer_id, "Выгрузка базы данных:", attachment=",".join(attachments))
                    else:
                        send_message(event.peer_id, "Файлы базы данных отсутствуют на сервере.")
                
                except Exception as e:
                    send_message(event.peer_id, f"Ошибка при отправке БД: {e}")
            else:
                # Опционально: сообщение, если команда вызвана не в том чате
                pass
