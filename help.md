Привет! В чате работает @jenbot. Он понимает следующие команды:
- **init _код чата_** - первичная инициализация бота в чате (выполняется один раз)
- **ping _hostname_ _hostname..._** - пинг сервера. Например для определения IP    
- **commits _Номер таска_ _Номер таска..._** - Выводит список файлов, измененных по таску(-ам)    
- **detail _Номер таска_ _Номер таска..._** - Выводит список файлов, измененных по таску(-ам) с деталями    
- **check** - выводит статус наблюдаемых сборок
- **stop _jobname_** - остановка обновления:
- **build _jobname_** - запуск обновления. Например:
    #foreach($job in $context.jobs)
    build $job
    #end