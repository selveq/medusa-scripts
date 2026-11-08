module.exports = {
    project: '__PROJECT__',
    services: {
        postgres: {
            user: 'medusa',
            password: 'medusa',
            database: 'medusa-backend',
        },
    },
    admin: {
        email: 'admin@__PROJECT__.local',
    },
    apps: {
        backend: {
            dir: 'apps/__BACKEND__',
        },
        '__STORE__': {},
    },
    proxy: {
        domain: 'localhost',
    },
    tunnel: {
        name: '__PROJECT__',
    },
}
